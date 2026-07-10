// Телеграм-бот Downy: ссылка в чат → скачали через yt-dlp на этом ПК →
// отправили файл обратно → стёрли с диска. Комп — перевалочный пункт.
//
// MTProto (gramjs) с bot token: лимит отправки 2 GB вместо 50 MB Bot API,
// без self-hosted сервера.

import bigInt from 'big-integer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api, TelegramClient } from 'telegram';
import { CallbackQuery, type CallbackQueryEvent } from 'telegram/events/CallbackQuery';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import { Button } from 'telegram/tl/custom/button';
import { sanitizeFilename } from '../../shared/filename';
import type { CutRange, ProbeFormat, StreamSelection } from '../../shared/protocol';
import { createYtdlpEngine, type YtdlpDownloadHandle } from '../../shared/ytdlp';
import { loadConfig } from './config';
import { probeVideoMeta } from './ffmeta';
import { isPlaylistUrl, parseCommand } from './parse';
import { pickQuality } from './quality';
import { SerialQueue } from './queue';
import { loadState, saveState, type PeerRef } from './state';

// __dirname указывает на bot/dist после сборки
const botDir = path.join(__dirname, '..');
const logFile = path.join(botDir, 'bot.log');

function log(...args: unknown[]): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
  } catch {
    // лог не критичен
  }
}

function mustLoadConfig(): Exclude<ReturnType<typeof loadConfig>, string> {
  const c = loadConfig(path.join(botDir, 'config.json'));
  if (typeof c === 'string') {
    console.error(c);
    log('config error:', c);
    process.exit(1);
  }
  return c;
}
const cfg = mustLoadConfig();

const engine = createYtdlpEngine({ binDir: path.join(botDir, '..', 'coapp', 'bin'), log });
// Труба: скачали → отправили → стёрли. Свой tmp, чтобы не гадить в папку,
// куда расширение складывает то, что юзер просил сохранить на диск.
const tmpDir = path.join(botDir, 'tmp');
const saveDir = path.join(os.homedir(), 'Downloads', 'downy');
const sessionFile = path.join(botDir, 'session.txt');

/** Жёсткий потолок Telegram на файл от бота — 2 GB; чуть отступаем */
const SEND_LIMIT_BYTES = 2_000_000_000;

const HELP = [
  'Кинь ссылку на страницу с видео — скачаю и пришлю сюда.',
  '',
  'Модификаторы (в любом порядке, через пробел):',
  '• качество: `720`, `1080` — не выше этой высоты',
  '• только звук: `audio`',
  '• отрезок: `1:20-2:45`, `90-120`, `1:20-`, `-2:45`',
  '',
  'Пример: `https://youtu.be/… 720 1:00-2:30`',
  '',
  'Если комп выключен — ссылка не пропадёт: скачаю и пришлю, как только комп включится.',
].join('\n');

// ---------- Состояние ----------

interface ActiveJob {
  handle: YtdlpDownloadHandle;
  canceledByUser: boolean;
}

interface SaveOffer {
  chatId: number;
  title: string;
  /** Файл уже лежит в tmp — просто перенести */
  tmpFile?: string;
  /** Иначе — скачать заново в оригинальном качестве */
  pageUrl?: string;
  streams?: StreamSelection;
  cut?: CutRange;
}

let tokenSeq = 0;
const activeJobs = new Map<string, ActiveJob>();
const saveOffers = new Map<string, SaveOffer>();
const queue = new SerialQueue((e) => log('queue task error:', e instanceof Error ? (e.stack ?? e.message) : String(e)));

const stateFile = path.join(botDir, 'state.json');
const state = loadState(stateFile);

const session = new StringSession(fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '');
const client = new TelegramClient(session, cfg.apiId, cfg.apiHash, {
  connectionRetries: Number.MAX_SAFE_INTEGER,
  autoReconnect: true,
  floodSleepThreshold: 300,
});

// ---------- Утилиты ----------

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function progressBar(p: number): string {
  const filled = Math.round(p * 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'видео';
  }
}

function allowed(chatId: number): boolean {
  return cfg.allowedChatIds.includes(chatId);
}

/**
 * Адресат для отправки: после рестарта кэш пиров gramjs пуст и голый chatId
 * может не зарезолвиться — используем InputPeer из state.json, когда он есть.
 */
function entityFor(chatId: number): Api.TypeInputPeer | number {
  const ref = state.peers[String(chatId)];
  return ref ? toInputPeer(ref) : chatId;
}

async function reply(chatId: number, text: string): Promise<void> {
  try {
    await client.sendMessage(entityFor(chatId), { message: text });
  } catch (e) {
    log('sendMessage failed:', e instanceof Error ? e.message : String(e));
  }
}

type Buttons = Api.KeyboardButtonCallback[];

/** Редактор статус-сообщения: не чаще раза в 3 сек, без дублей текста */
function makeStatusEditor(chatId: number, msgId: number) {
  let lastAt = 0;
  let lastText = '';
  let busy = false;
  return async (text: string, opts?: { buttons?: Buttons; force?: boolean }): Promise<void> => {
    const now = Date.now();
    if (!opts?.force && now - lastAt < 3000) return;
    if (busy || text === lastText) return;
    busy = true;
    lastAt = now;
    lastText = text;
    try {
      await client.editMessage(entityFor(chatId), { message: msgId, text, buttons: opts?.buttons });
    } catch {
      // MESSAGE_NOT_MODIFIED и гонки редактирования не критичны
    } finally {
      busy = false;
    }
  };
}

/** Промис-обёртка над движком + регистрация handle для кнопки отмены */
function runEngineDownload(
  token: string,
  opts: Parameters<typeof engine.download>[0],
  onProgress: (p: { progress: number; bytes?: number; totalBytes?: number }) => void,
): Promise<{ state: 'done' | 'error' | 'canceled' | 'paused'; outFile?: string; message?: string }> {
  return new Promise((resolve) => {
    const handle = engine.download(opts, {
      onProgress,
      onFinish: (r) => {
        activeJobs.delete(token);
        resolve(r);
      },
    });
    activeJobs.set(token, { handle, canceledByUser: false });
  });
}

// ---------- Сценарий закачки ----------

interface DlTask {
  chatId: number;
  pageUrl: string;
  streams: StreamSelection;
  maxHeight?: number;
  cut?: CutRange;
  /** send — прислать в чат и стереть; save — положить в Downloads\downy */
  mode: 'send' | 'save';
}

async function enqueueTask(task: DlTask): Promise<void> {
  const status = await client.sendMessage(entityFor(task.chatId), { message: '🕒 Принял, сейчас гляну…' });
  const edit = makeStatusEditor(task.chatId, status.id);
  const ahead = queue.push(() => runTask(task, edit));
  if (ahead > 0) await edit(`🕒 В очереди, впереди закачек: ${ahead}`, { force: true });
}

async function runTask(task: DlTask, edit: ReturnType<typeof makeStatusEditor>): Promise<void> {
  const token = String(++tokenSeq);
  await edit('🔍 Разведка форматов…', { force: true });

  const pr = await engine.probe(task.pageUrl);
  if (!pr.ok) {
    await edit(`❌ Не разобрал ссылку: ${pr.error}`, { force: true });
    return;
  }
  const title = pr.title?.trim() || hostnameOf(task.pageUrl);
  const formats: ProbeFormat[] = pr.formats ?? [];

  // Лестница качеств для спуска, если файл не влезает в лимит
  const heights = [...new Set(formats.filter((f) => f.hasVideo && f.height).map((f) => f.height!))].sort((a, b) => b - a);
  let height: number | undefined;
  let originalHeight: number | undefined;
  if (task.streams !== 'audio' && task.mode === 'send') {
    const pick = pickQuality(formats, task.maxHeight ?? cfg.maxHeight ?? 1080, SEND_LIMIT_BYTES);
    height = pick.height;
    originalHeight = pick.originalHeight;
  } else if (task.streams !== 'audio') {
    height = task.maxHeight; // save: без лимита, качаем что просили (или лучшее)
  }

  const cancelBtn = [Button.inline('❌ Отменить', Buffer.from(`c:${token}`))];
  const outDir = task.mode === 'send' ? tmpDir : saveDir;

  // Спуск по качеству: оценка probe могла соврать — проверяем фактический размер
  for (;;) {
    const suffix = (height ? ` [${height}p]` : '') + (task.streams === 'audio' ? ' [аудио]' : '') + (task.cut ? ' [отрезок]' : '');
    const stem = sanitizeFilename(title + suffix);
    const label = height ? `${height}p` : task.streams === 'audio' ? 'аудио' : 'лучшее';

    const r = await runEngineDownload(
      token,
      { pageUrl: task.pageUrl, outDir, streams: task.streams, filenameStem: stem, maxHeight: height, cut: task.cut },
      (p) => {
        const size = p.totalBytes ? ` · ${fmtBytes(p.bytes ?? 0)} / ${fmtBytes(p.totalBytes)}` : '';
        void edit(`⏬ ${title} (${label})\n${progressBar(p.progress)} ${Math.round(p.progress * 100)}%${size}`, { buttons: cancelBtn });
      },
    );

    if (r.state === 'canceled' || r.state === 'paused') {
      await edit('❌ Отменено.', { force: true });
      return;
    }
    if (r.state === 'error' || !r.outFile) {
      await edit(`❌ Не скачалось: ${r.message ?? 'без объяснений'}`, { force: true });
      return;
    }

    const size = fs.statSync(r.outFile).size;

    if (task.mode === 'save') {
      await edit(`💾 Сохранено на комп (${fmtBytes(size)}):\n${r.outFile}`, { force: true });
      return;
    }

    if (size > SEND_LIMIT_BYTES) {
      const lower = heights.find((h) => h < (height ?? Infinity));
      if (task.streams !== 'audio' && lower) {
        fs.rmSync(r.outFile, { force: true });
        originalHeight = originalHeight ?? height;
        height = lower;
        await edit(`📐 ${fmtBytes(size)} в Telegram не влезает — пробую ${lower}p…`, { force: true });
        continue;
      }
      // Ниже спускаться некуда — файл остаётся, решает юзер
      saveOffers.set(token, { chatId: task.chatId, title, tmpFile: r.outFile });
      await edit(`⚠️ Скачал, но ${fmtBytes(size)} в Telegram не влезает (лимит 2 GB). Что делаем?`, {
        force: true,
        buttons: [Button.inline('💾 На комп', Buffer.from(`s:${token}`)), Button.inline('🗑 Удалить', Buffer.from(`d:${token}`))],
      });
      return;
    }

    await sendResult(task, token, title, r.outFile, size, height, originalHeight, edit);
    return;
  }
}

async function sendResult(
  task: DlTask,
  token: string,
  title: string,
  outFile: string,
  size: number,
  height: number | undefined,
  originalHeight: number | undefined,
  edit: ReturnType<typeof makeStatusEditor>,
): Promise<void> {
  await edit(`📤 Отправляю (${fmtBytes(size)})…`, { force: true });

  const meta = await probeVideoMeta(engine.ffmpegPath, outFile);
  const attributes =
    task.streams === 'audio'
      ? [new Api.DocumentAttributeAudio({ duration: meta.durationSec ?? 0, title })]
      : [
          new Api.DocumentAttributeVideo({
            duration: meta.durationSec ?? 0,
            w: meta.width ?? 0,
            h: meta.height ?? 0,
            supportsStreaming: true,
          }),
        ];

  const downgraded = originalHeight != null && height != null && height < originalHeight;
  let caption = title;
  let buttons: Buttons | undefined;
  if (downgraded) {
    caption += `\n⚠️ Оригинал ${originalHeight}p в лимит Telegram (2 GB) не влез — это ${height}p.`;
    saveOffers.set(token, { chatId: task.chatId, title, pageUrl: task.pageUrl, streams: task.streams, cut: task.cut });
    buttons = [Button.inline('💾 Оригинал на комп', Buffer.from(`s:${token}`))];
  }

  let lastPct = -1;
  try {
    await client.sendFile(entityFor(task.chatId), {
      file: outFile,
      caption,
      attributes,
      buttons,
      workers: 8,
      progressCallback: (p: number) => {
        const pct = Math.round(p * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        void edit(`📤 Отправляю: ${progressBar(p)} ${pct}%`);
      },
    });
    await edit('✅ Готово.', { force: true });
    fs.rmSync(outFile, { force: true });
    log('sent', outFile, fmtBytes(size), 'to', task.chatId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('send failed:', msg);
    // Файл уже скачан — не выбрасываем, предлагаем спасти на комп
    saveOffers.set(token, { chatId: task.chatId, title, tmpFile: outFile });
    await edit(`❌ Не отправилось: ${msg}\nФайл скачан (${fmtBytes(size)}). Что делаем?`, {
      force: true,
      buttons: [Button.inline('💾 На комп', Buffer.from(`s:${token}`)), Button.inline('🗑 Удалить', Buffer.from(`d:${token}`))],
    });
  }
}

// ---------- Пропущенное за время выключенного компа ----------

/** InputPeer чата — в state.json, чтобы после рестарта достучаться до чата */
async function rememberPeer(chatId: number): Promise<void> {
  if (state.peers[String(chatId)]) return;
  try {
    const input = await client.getInputEntity(chatId);
    let ref: PeerRef | null = null;
    if (input instanceof Api.InputPeerUser) ref = { type: 'user', id: input.userId.toString(), accessHash: input.accessHash.toString() };
    else if (input instanceof Api.InputPeerChat) ref = { type: 'chat', id: input.chatId.toString() };
    else if (input instanceof Api.InputPeerChannel) ref = { type: 'channel', id: input.channelId.toString(), accessHash: input.accessHash.toString() };
    if (ref) {
      state.peers[String(chatId)] = ref;
      saveState(stateFile, state);
    }
  } catch (e) {
    log('rememberPeer failed for', chatId, e instanceof Error ? e.message : String(e));
  }
}

function toInputPeer(ref: PeerRef): Api.TypeInputPeer {
  if (ref.type === 'user') return new Api.InputPeerUser({ userId: bigInt(ref.id), accessHash: bigInt(ref.accessHash ?? '0') });
  if (ref.type === 'chat') return new Api.InputPeerChat({ chatId: bigInt(ref.id) });
  return new Api.InputPeerChannel({ channelId: bigInt(ref.id), accessHash: bigInt(ref.accessHash ?? '0') });
}

function markProcessed(chatId: number, msgId: number): void {
  const key = String(chatId);
  if ((state.lastMsgId[key] ?? 0) >= msgId) return;
  state.lastMsgId[key] = msgId;
  saveState(stateFile, state);
}

/** Ссылки, присланные пока комп был выключен: перечитать и скачать */
async function backfillMissed(): Promise<void> {
  for (const chatId of cfg.allowedChatIds) {
    const key = String(chatId);
    const ref = state.peers[key];
    const lastId = state.lastMsgId[key];
    if (!ref || lastId == null) continue; // чат ещё не писал при живом боте
    let msgs: Api.Message[];
    try {
      msgs = await client.getMessages(toInputPeer(ref), { minId: lastId, limit: 100 });
    } catch (e) {
      log('backfill getMessages failed for', chatId, e instanceof Error ? e.message : String(e));
      continue;
    }
    const incoming = msgs.filter((m) => !m.out && m.message).sort((a, b) => a.id - b.id);
    if (incoming.length > 0) markProcessed(chatId, incoming[incoming.length - 1].id);

    const tasks: DlTask[] = [];
    for (const m of incoming) {
      const cmd = parseCommand(m.message);
      // Ошибки и болтовню в бэкфиле молча пропускаем — контекст диалога ушёл
      if (!cmd || 'error' in cmd || isPlaylistUrl(cmd.url)) continue;
      tasks.push({ chatId, pageUrl: cmd.url, streams: cmd.streams, maxHeight: cmd.maxHeight, cut: cmd.cut, mode: 'send' });
    }
    if (tasks.length === 0) continue;
    log('backfill:', tasks.length, 'missed link(s) in chat', chatId);
    await reply(chatId, `⚡ Пока комп был выключен, пришло запросов: ${tasks.length}. Качаю по очереди.`);
    for (const t of tasks) await enqueueTask(t);
  }
}

// ---------- Обработчики ----------

async function onMessage(event: NewMessageEvent): Promise<void> {
  const text = event.message?.message ?? '';
  if (!event.chatId) return;
  const chatId = Number(event.chatId);

  if (cfg.allowedChatIds.length === 0) {
    // Режим первого контакта: бот только что поднят, хозяина ещё не знает
    await reply(chatId, `Твой chat_id: ${chatId}\nВпиши его в bot/config.json → allowedChatIds и перезапусти бота (или задачу DownyBot в Планировщике).`);
    return;
  }
  if (!allowed(chatId)) {
    log('rejected chat', chatId, 'text:', text.slice(0, 80));
    await reply(chatId, 'Это приватный бот.');
    return;
  }

  // След для бэкфила: как достучаться до чата и что уже обработано
  await rememberPeer(chatId);
  markProcessed(chatId, event.message.id);

  if (/^\/(start|help)/.test(text)) {
    await reply(chatId, HELP);
    return;
  }

  const cmd = parseCommand(text);
  if (!cmd) {
    await reply(chatId, HELP);
    return;
  }
  if ('error' in cmd) {
    await reply(chatId, `❌ ${cmd.error}`);
    return;
  }
  if (isPlaylistUrl(cmd.url)) {
    await reply(chatId, '❌ Плейлисты целиком не качаю — кинь ссылку на конкретное видео.');
    return;
  }
  await enqueueTask({ chatId, pageUrl: cmd.url, streams: cmd.streams, maxHeight: cmd.maxHeight, cut: cmd.cut, mode: 'send' });
}

async function onCallback(event: CallbackQueryEvent): Promise<void> {
  const data = event.data?.toString('utf8') ?? '';
  const chatId = Number(event.chatId ?? 0);
  if (!allowed(chatId)) {
    await event.answer({ message: 'Это приватный бот.' });
    return;
  }
  const [kind, token] = data.split(':');

  if (kind === 'c') {
    const job = activeJobs.get(token);
    if (!job) {
      await event.answer({ message: 'Уже неактуально.' });
      return;
    }
    job.canceledByUser = true;
    job.handle.cancel();
    await event.answer({ message: 'Отменяю…' });
    return;
  }

  const offer = saveOffers.get(token);
  if (!offer || offer.chatId !== chatId) {
    await event.answer({ message: 'Кнопка устарела — кинь ссылку заново.' });
    return;
  }

  if (kind === 's') {
    saveOffers.delete(token);
    if (offer.tmpFile) {
      // Файл уже скачан — просто переносим из tmp в Downloads\downy
      try {
        fs.mkdirSync(saveDir, { recursive: true });
        const dest = path.join(saveDir, path.basename(offer.tmpFile));
        fs.renameSync(offer.tmpFile, dest);
        await event.answer({ message: 'Сохранил.' });
        await reply(chatId, `💾 Сохранено на комп:\n${dest}`);
      } catch (e) {
        await event.answer({ message: 'Не вышло, подробности в чате.' });
        await reply(chatId, `❌ Не смог перенести файл: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (offer.pageUrl) {
      await event.answer({ message: 'Ставлю в очередь.' });
      await enqueueTask({ chatId, pageUrl: offer.pageUrl, streams: offer.streams ?? 'both', cut: offer.cut, mode: 'save' });
    }
    return;
  }

  if (kind === 'd') {
    saveOffers.delete(token);
    if (offer.tmpFile) fs.rmSync(offer.tmpFile, { force: true });
    await event.answer({ message: 'Удалил.' });
    await reply(chatId, '🗑 Удалил.');
  }
}

// ---------- Старт ----------

function cleanupTmp(): void {
  // Хвосты старше суток: юзер так и не решил, что делать с неотправленным
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(tmpDir)) {
      const full = path.join(tmpDir, f);
      if (fs.statSync(full).mtimeMs < dayAgo) fs.rmSync(full, { force: true });
    }
  } catch {
    // не критично
  }
}

process.on('uncaughtException', (e) => log('uncaught', e.stack ?? e.message));
process.on('unhandledRejection', (e) => log('unhandled rejection', e instanceof Error ? (e.stack ?? e.message) : String(e)));

async function main(): Promise<void> {
  cleanupTmp();
  if (!engine.ytdlpWorks()) {
    console.error('yt-dlp не найден — запусти npm run coapp:fetch-bins');
    log('yt-dlp missing');
    process.exit(1);
  }
  await client.start({ botAuthToken: cfg.botToken });
  fs.writeFileSync(sessionFile, String(client.session.save()));
  const me = await client.getMe();
  log('bot started as @' + (me.username ?? '?'));
  console.log(`Бот запущен: @${me.username ?? '?'}`);

  client.addEventHandler((e: NewMessageEvent) => void onMessage(e).catch((err) => log('onMessage error:', err?.stack ?? err)), new NewMessage({ incoming: true }));
  client.addEventHandler((e: CallbackQueryEvent) => void onCallback(e).catch((err) => log('onCallback error:', err?.stack ?? err)), new CallbackQuery());

  await backfillMissed();
}

void main().catch((e) => {
  log('fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  console.error(e);
  process.exit(1);
});
