import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMessages, sendMessage } from './nm';
import type {
  CoAppRequest,
  CutRange,
  DirectJobRequest,
  HlsJobRequest,
  JobEvent,
  PickDirRequest,
  ProbeFormat,
  ProbeRequest,
  StreamSelection,
  ThumbnailJobRequest,
  ThumbRequest,
  UpdateRequest,
  YtdlpJobRequest,
} from '../../shared/protocol';

// Держи в синхроне с extension/manifest.json и package.json
const VERSION = '0.7.0';

// __dirname указывает на coapp/dist после сборки
const coappRoot = path.join(__dirname, '..');
const binDir = path.join(coappRoot, 'bin');
const logFile = path.join(coappRoot, 'coapp.log');

function log(...args: unknown[]): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
  } catch {
    // лог не критичен
  }
}

function findBin(name: string): string {
  const local = path.join(binDir, `${name}.exe`);
  return fs.existsSync(local) ? local : name; // иначе надеемся на PATH
}

const ffmpegPath = findBin('ffmpeg');
const ytdlpPath = findBin('yt-dlp');

function binWorks(bin: string, versionArg: string): boolean {
  try {
    return spawnSync(bin, [versionArg], { windowsHide: true, timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

let ytdlpOkCache: boolean | null = null;
function ytdlpWorks(): boolean {
  if (ytdlpOkCache == null) ytdlpOkCache = binWorks(ytdlpPath, '--version');
  return ytdlpOkCache;
}

// Сегменты HLS качаем параллельно: последовательная загрузка упирается в
// задержку сети и per-connection-троттлинг CDN (ВК и т.п.)
const HLS_CONCURRENCY = '8';

// Без --encoding yt-dlp пишет в stdout в кодировке консоли (cp1251) — кириллица
// в путях превращается в кракозябры, и «показать в папке» не находит файл
const YTDLP_COMMON_ARGS = ['--newline', '--encoding', 'utf-8'];

const defaultOutDir = path.join(os.homedir(), 'Downloads', 'downy');

function resolveOutDir(requested?: string): string {
  const dir = requested?.trim() || defaultOutDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

interface RunningJob {
  canceled: boolean;
  /** Пауза: процесс убиваем, но недокачанное оставляем для резюма */
  paused: boolean;
  kill(): void;
}

const jobs = new Map<string, RunningJob>();

function processJob(child: ChildProcess): RunningJob {
  return {
    canceled: false,
    paused: false,
    kill() {
      const pid = child.pid;
      if (pid) {
        // yt-dlp порождает ffmpeg — убиваем всё дерево процессов
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          return;
        } catch {
          // ниже — фолбэк
        }
      }
      child.kill();
    },
  };
}

function emit(event: JobEvent): void {
  sendMessage(event);
}

function jobDone(
  jobId: string,
  code: number | null,
  flags: { canceled: boolean; paused?: boolean },
  outFile: string,
  errTail: string,
  pausedKeepsFile = true,
): void {
  jobs.delete(jobId);
  if (flags.paused) {
    // outFile в событии = «есть что докачивать»; без него резюм начнёт сначала
    if (pausedKeepsFile) {
      emit({ type: 'job', jobId, state: 'paused', progress: null, outFile });
    } else {
      fs.rm(outFile, { force: true }, () => {});
      emit({ type: 'job', jobId, state: 'paused', progress: null });
    }
  } else if (flags.canceled) {
    fs.rm(outFile, { force: true }, () => {});
    emit({ type: 'job', jobId, state: 'canceled', progress: null });
  } else if (code === 0) {
    emit({ type: 'job', jobId, state: 'done', progress: 1, outFile });
  } else {
    emit({ type: 'job', jobId, state: 'error', progress: null, message: errTail.slice(-500) || `exit code ${code}` });
  }
}

/**
 * Парсер stdout yt-dlp: строки прогресса вида
 * "[download]  42.5% of   12.34MiB at  1.23MiB/s ETA 00:05" и путь итогового файла.
 */
function makeYtdlpStdoutHandler(jobId: string, onOutFile?: (file: string) => void): (d: Buffer) => void {
  let lastSent = 0;
  return (d: Buffer) => {
    const s = d.toString();
    if (onOutFile) {
      const dest = s.match(/\[download\] Destination: (.+)/) ?? s.match(/\[Merger\] Merging formats into "(.+)"/);
      if (dest) onOutFile(dest[1].trim());
    }
    const pct = s.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)(B|KiB|MiB|GiB|TiB))?/);
    if (!pct) return;
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    const progress = Math.min(0.999, parseFloat(pct[1]) / 100);
    let totalBytes: number | undefined;
    if (pct[2]) {
      const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[pct[3] as 'B' | 'KiB' | 'MiB' | 'GiB' | 'TiB'];
      totalBytes = Math.round(parseFloat(pct[2]) * mult);
    }
    emit({
      type: 'job',
      jobId,
      state: 'running',
      progress,
      totalBytes,
      bytes: totalBytes ? Math.round(totalBytes * progress) : undefined,
    });
  };
}

/** Убирает сам файл и хвосты yt-dlp (.part, .part-FragN, .ytdl) */
function cleanupPartials(outFile: string): void {
  const dir = path.dirname(outFile);
  const base = path.basename(outFile);
  try {
    for (const f of fs.readdirSync(dir)) {
      // Только известные суффиксы yt-dlp: по голому префиксу можно зацепить
      // чужой файл вида «имя.mp4.bak»
      if (f === base || f.startsWith(`${base}.part`) || f === `${base}.ytdl`) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch {
    // папку могли удалить — не мешаем завершению джоба
  }
}

function startHls(req: HlsJobRequest): void {
  const streams = req.streams ?? 'both';
  let outFile: string;
  try {
    if (req.resumePath) {
      // Докачка после паузы: тот же файл, yt-dlp сам продолжит .part
      outFile = req.resumePath;
    } else {
      const outDir = resolveOutDir(req.outDir);
      const wantExt = streams === 'audio' ? '.m4a' : '.mp4';
      const filename = req.filename.toLowerCase().endsWith(wantExt) ? req.filename : `${req.filename}${wantExt}`;
      outFile = uniquePath(outDir, filename);
    }
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  // yt-dlp качает сегменты параллельно и обходит троттлинг на одно соединение;
  // ffmpeg (последовательный) — фолбэк и путь для отрезков: -ss пропускает
  // сегменты до начала, качается только нужный кусок
  if (ytdlpWorks() && !req.cut) startHlsYtdlp(req, outFile, streams);
  else startFfmpegCopy(req, outFile, streams);
}

function startHlsYtdlp(req: HlsJobRequest, outFile: string, streams: StreamSelection): void {
  // Дорожку вырезаем после скачивания: в муксованном HLS yt-dlp не умеет
  // отдать только видео/аудио, а качать медленным ffmpeg напрямую — терять скорость
  const dlFile = streams === 'both' ? outFile : `${outFile}.dl.mp4`;
  const args = [...YTDLP_COMMON_ARGS, '--no-playlist', '--concurrent-fragments', HLS_CONCURRENCY, '-o', dlFile];
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  if (req.headers?.userAgent) args.push('--user-agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('--referer', req.headers.referer);
  args.push(req.url);

  log('yt-dlp hls start', req.jobId, req.url, '->', outFile, 'streams:', streams);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let errTail = '';
  child.stdout?.on('data', makeYtdlpStdoutHandler(req.jobId));
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  // При ошибке спавна срабатывают и 'error', и 'close' — фолбэк должен быть один
  let settled = false;
  const fallback = (reason: string): void => {
    if (settled) return;
    settled = true;
    log('yt-dlp hls fallback to ffmpeg', req.jobId, reason.slice(-300));
    jobs.delete(req.jobId);
    cleanupPartials(dlFile);
    startFfmpegCopy(req, outFile, streams);
  };

  child.on('error', (e) => {
    fallback(`spawn error: ${e.message}`);
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    log('yt-dlp hls exit', req.jobId, code, 'canceled:', job.canceled, 'paused:', job.paused);
    if (job.paused) {
      // Хвосты .part остаются на диске — по ним yt-dlp продолжит
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, outFile });
    } else if (job.canceled) {
      jobs.delete(req.jobId);
      cleanupPartials(dlFile);
      emit({ type: 'job', jobId: req.jobId, state: 'canceled', progress: null });
    } else if (code === 0) {
      if (streams === 'both') jobDone(req.jobId, code, job, outFile, errTail);
      else stripTracks(req.jobId, dlFile, outFile, streams);
    } else {
      fallback(errTail);
    }
  });
}

/** Копирует из скачанного файла только выбранную дорожку (без перекодирования). */
function stripTracks(jobId: string, srcFile: string, outFile: string, streams: 'video' | 'audio'): void {
  // Отмена могла прийти в зазор между выходом yt-dlp и этим вызовом —
  // тогда она осела в уже завершившемся джобе
  if (jobs.get(jobId)?.canceled) {
    jobs.delete(jobId);
    try {
      fs.rmSync(srcFile, { force: true });
    } catch {
      // временный файл не критичен
    }
    emit({ type: 'job', jobId, state: 'canceled', progress: null });
    return;
  }
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', srcFile];
  args.push('-map', streams === 'video' ? '0:v' : '0:a', '-c', 'copy');
  if (/\.(mp4|m4a|mov)$/i.test(outFile)) args.push('-movflags', '+faststart');
  args.push(outFile);

  log('strip start', jobId, srcFile, '->', outFile);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // Отмена с этого момента должна убивать ffmpeg, а не завершившийся yt-dlp
  const job = processJob(child);
  jobs.set(jobId, job);

  let errTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  let settled = false;
  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    // Синхронно: после jobDone хост могут закрыть, и хвост останется на диске
    try {
      fs.rmSync(srcFile, { force: true });
    } catch {
      // временный файл не критичен
    }
    log('strip exit', jobId, code, 'canceled:', job.canceled);
    // Вырезка дорожки — быстрая локальная операция, пауза к ней не применяется
    jobDone(jobId, code, { canceled: job.canceled }, outFile, errTail);
  };
  child.on('error', (e) => {
    errTail = `Не удалось запустить ffmpeg: ${e.message}`;
    finish(1);
  });
  child.on('close', finish);
}

interface FfmpegCopySource {
  jobId: string;
  url: string;
  cut?: CutRange;
  headers?: { referer?: string; userAgent?: string };
}

function startFfmpegCopy(req: FfmpegCopySource, outFile: string, streams: StreamSelection): void {
  const args = ['-y', '-nostdin', '-hide_banner'];
  if (req.headers?.userAgent) args.push('-user_agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('-referer', req.headers.referer);
  // -ss до -i — быстрый пропуск до ключевого кадра, без чтения всего начала
  if (req.cut?.fromSec) args.push('-ss', String(req.cut.fromSec));
  args.push('-i', req.url);
  if (streams === 'video') args.push('-map', '0:v');
  else if (streams === 'audio') args.push('-map', '0:a');
  args.push('-c', 'copy');
  const cutDur = req.cut?.toSec != null ? req.cut.toSec - (req.cut.fromSec ?? 0) : undefined;
  if (cutDur && cutDur > 0) args.push('-t', String(cutDur));
  if (/\.(mp4|m4a|mov)$/i.test(outFile)) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', outFile);

  log('ffmpeg start', req.jobId, req.url, '->', outFile);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let durationSec: number | null = null;
  let errTail = '';
  let lastSent = 0;

  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    errTail = (errTail + s).slice(-2000);
    if (durationSec == null) {
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
    }
  });

  let writtenBytes = 0;
  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    const sizeMatch = s.match(/total_size=(\d+)/);
    if (sizeMatch) writtenBytes = Number(sizeMatch[1]);
    const timeMatch = s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    let progress: number | null = null;
    if (timeMatch && durationSec) {
      const done = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      // out_time считает выход (уже относительно начала отрезка) — шкалу
      // меряем длиной отрезка, а не всего ролика
      const from = req.cut?.fromSec ?? 0;
      const end = req.cut?.toSec != null ? Math.min(req.cut.toSec, durationSec) : durationSec;
      const total = end - from;
      if (total > 0) progress = Math.min(0.999, done / total);
    }
    emit({
      type: 'job',
      jobId: req.jobId,
      state: 'running',
      progress,
      bytes: writtenBytes || undefined,
    });
  });

  child.on('error', (e) => {
    jobs.delete(req.jobId);
    log('ffmpeg spawn error', e.message);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить ffmpeg: ${e.message}` });
  });

  child.on('close', (code) => {
    log('ffmpeg exit', req.jobId, code, 'canceled:', job.canceled, 'paused:', job.paused);
    // Обрубленный ffmpeg-файл не докачивается — пауза здесь = начать заново
    jobDone(req.jobId, code, job, outFile, errTail, false);
  });
}

async function startDirect(req: DirectJobRequest): Promise<void> {
  let outFile: string;
  let startBytes = 0;
  try {
    if (req.resumePath) {
      // Докачка после паузы: продолжаем тот же файл с байта, где остановились
      outFile = req.resumePath;
      try {
        startBytes = fs.statSync(outFile).size;
      } catch {
        startBytes = 0; // файл увели — качаем заново
      }
    } else {
      const outDir = resolveOutDir(req.outDir);
      outFile = uniquePath(outDir, req.filename);
    }
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  // Отдельную дорожку или отрезок из файла умеет вырезать только ffmpeg
  // (без перекодирования; отрезок читается прямо по http range)
  const streams = req.streams ?? 'both';
  if (streams !== 'both' || req.cut) {
    startFfmpegCopy(req, outFile, streams);
    return;
  }

  const ac = new AbortController();
  const job: RunningJob = { canceled: false, paused: false, kill: () => ac.abort() };
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });
  log('direct start', req.jobId, req.url, '->', outFile);

  const headers: Record<string, string> = {};
  if (req.headers?.referer) headers.Referer = req.headers.referer;
  if (req.headers?.userAgent) headers['User-Agent'] = req.headers.userAgent;
  if (startBytes > 0) headers.Range = `bytes=${startBytes}-`;

  let out: fs.WriteStream | null = null;
  let bytes = startBytes;
  try {
    const resp = await fetch(req.url, { headers, signal: ac.signal, redirect: 'follow' });
    if (resp.status === 416 && startBytes > 0) {
      // Диапазон за концом файла — всё уже скачано до паузы
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'done', progress: 1, bytes: startBytes, outFile });
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error('пустой ответ сервера');
    const appending = startBytes > 0 && resp.status === 206;
    if (startBytes > 0 && !appending) {
      // Сервер не умеет Range — честно начинаем сначала
      startBytes = 0;
      bytes = 0;
    }
    let totalBytes: number | undefined;
    if (appending) {
      const m = resp.headers.get('content-range')?.match(/\/(\d+)\s*$/);
      totalBytes = m ? Number(m[1]) : startBytes + (Number(resp.headers.get('content-length')) || 0) || undefined;
    } else {
      totalBytes = Number(resp.headers.get('content-length')) || undefined;
    }
    out = fs.createWriteStream(outFile, { flags: appending ? 'a' : 'w' });
    let lastSent = 0;
    for await (const chunk of resp.body) {
      const buf = Buffer.from(chunk as Uint8Array);
      bytes += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
      const now = Date.now();
      if (now - lastSent >= 1000) {
        lastSent = now;
        emit({
          type: 'job',
          jobId: req.jobId,
          state: 'running',
          progress: totalBytes ? Math.min(0.999, bytes / totalBytes) : null,
          bytes,
          totalBytes,
        });
      }
    }
    await new Promise<void>((resolve, reject) => out!.end((err?: Error | null) => (err ? reject(err) : resolve())));
    jobs.delete(req.jobId);
    log('direct done', req.jobId, bytes, 'bytes');
    emit({ type: 'job', jobId: req.jobId, state: 'done', progress: 1, bytes, totalBytes, outFile });
  } catch (e) {
    jobs.delete(req.jobId);
    if (out) out.destroy();
    if (job.paused) {
      // Недокачанное оставляем — по нему продолжим через Range
      log('direct paused', req.jobId, bytes, 'bytes');
      emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, bytes, outFile });
      return;
    }
    // недокачанный файл бесполезен — убираем и при отмене, и при ошибке
    fs.rm(outFile, { force: true }, () => {});
    if (job.canceled) {
      log('direct canceled', req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'canceled', progress: null });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log('direct error', req.jobId, msg);
      emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: msg });
    }
  }
}

/** Локальная дата скачивания для имени файла: 2026-07-10 */
function localDateStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Формат-строка yt-dlp: предпочитаем mp4/m4a, качество не выше maxHeight */
function ytdlpFormatArgs(streams: StreamSelection, maxHeight?: number): string[] {
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  if (streams === 'video') return ['-f', `bestvideo${h}[ext=mp4]/bestvideo${h}/best${h}`];
  if (streams === 'audio') return ['-f', 'bestaudio[ext=m4a]/bestaudio/best'];
  return ['-f', `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${h}+bestaudio/best${h}`];
}

function startYtdlp(req: YtdlpJobRequest): void {
  let outDir: string;
  try {
    outDir = resolveOutDir(req.outDir);
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const streams = req.streams ?? 'both';
  const args = [
    ...YTDLP_COMMON_ARGS, '--no-playlist',
    '--concurrent-fragments', HLS_CONCURRENCY,
  ];
  let presetOutFile = '';
  if (req.resumePath || req.filenameStem) {
    // Резюм продолжает тот же файл; новое имя защищаем от перезаписи
    presetOutFile = req.resumePath ?? uniquePath(outDir, req.filenameStem + (streams === 'audio' ? '.m4a' : '.mp4'));
    args.push('-o', presetOutFile);
    // Контейнер в имени обещан — держим слово, даже если лучший кодек в webm
    if (streams === 'both') args.push('--merge-output-format', 'mp4');
    else if (streams === 'video') args.push('--remux-video', 'mp4');
    else args.push('--remux-video', 'm4a');
  } else {
    // Разведка не прошла — yt-dlp именует сам; дата вместо мусорного айдишника,
    // force-overwrites — иначе повторная закачка молча скипнется
    const nameSuffix = { both: '', video: ' [видео]', audio: ' [аудио]' }[streams];
    args.push('--force-overwrites', '-P', outDir, '-o', `%(title).120s${nameSuffix} [${localDateStamp()}].%(ext)s`);
  }
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  args.push(...ytdlpFormatArgs(streams, req.maxHeight));
  // Отрезок: yt-dlp качает только нужную секцию (режет ffmpeg по ключевым
  // кадрам). Ютубу не предлагаем — его SABR-потоки ffmpeg не читает
  if (req.cut) args.push('--download-sections', `*${req.cut.fromSec ?? 0}-${req.cut.toSec ?? 'inf'}`);
  args.push(req.pageUrl);

  log('yt-dlp start', req.jobId, req.pageUrl, 'streams:', streams, 'maxHeight:', req.maxHeight ?? 'best');
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let outFile = presetOutFile;
  let errTail = '';

  child.stdout?.on('data', makeYtdlpStdoutHandler(req.jobId, (f) => {
    if (!presetOutFile) outFile = f;
  }));

  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  child.on('error', (e) => {
    jobs.delete(req.jobId);
    log('yt-dlp spawn error', e.message);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить yt-dlp: ${e.message}` });
  });

  child.on('close', (code) => {
    log('yt-dlp exit', req.jobId, code, 'canceled:', job.canceled, 'paused:', job.paused);
    if (job.paused) {
      jobs.delete(req.jobId);
      // Без preset-имени резюм перезапустит yt-dlp — тот сам подхватит свои .part
      emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, outFile: presetOutFile || undefined });
    } else {
      jobDone(req.jobId, code, job, outFile, errTail);
    }
  });
}

// ---------- Разведка форматов (yt-dlp -J) ----------

const PROBE_TIMEOUT_MS = 30_000;

interface YtdlpJsonFormat {
  height?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  /** Суммарный битрейт, КБит/с — у HLS (X и ко) размера нет, оцениваем по нему */
  tbr?: number | null;
}

/** Вес формата: точный, приблизительный или оценка битрейт × длительность */
function formatSize(f: YtdlpJsonFormat, durationSec?: number | null): number | undefined {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  // tbr в КБит/с: × 1000 / 8 = × 125 байт в секунду
  if (f.tbr && durationSec) return Math.round(f.tbr * 125 * durationSec);
  return undefined;
}

function probe(req: ProbeRequest): void {
  const args = [...YTDLP_COMMON_ARGS, '--no-playlist', '-J', req.pageUrl];
  log('probe start', req.reqId, req.pageUrl);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const chunks: Buffer[] = [];
  let errTail = '';
  let finished = false;
  const finish = (payload: { ok: boolean; error?: string; title?: string; thumbnailUrl?: string; formats?: ProbeFormat[] }): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    sendMessage({ type: 'probe', reqId: req.reqId, ...payload });
  };
  const timer = setTimeout(() => {
    log('probe timeout', req.pageUrl);
    child.kill('SIGKILL');
    finish({ ok: false, error: 'Разведка форматов не уложилась в 30 секунд' });
  }, PROBE_TIMEOUT_MS);

  child.stdout?.on('data', (d: Buffer) => chunks.push(d));
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-1000);
  });
  child.on('error', (e) => finish({ ok: false, error: `Не удалось запустить yt-dlp: ${e.message}` }));
  child.on('close', (code) => {
    if (code !== 0) {
      log('probe failed', req.reqId, code, errTail.slice(-300));
      finish({ ok: false, error: errTail.slice(-500) || `yt-dlp: exit code ${code}` });
      return;
    }
    try {
      const info = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        title?: string;
        thumbnail?: string;
        duration?: number | null;
        formats?: YtdlpJsonFormat[];
      };
      const formats: ProbeFormat[] = (info.formats ?? []).map((f) => ({
        height: f.height ?? undefined,
        fps: f.fps ?? undefined,
        hasVideo: !!f.vcodec && f.vcodec !== 'none',
        hasAudio: !!f.acodec && f.acodec !== 'none',
        sizeBytes: formatSize(f, info.duration),
      }));
      log('probe done', req.reqId, formats.length, 'formats');
      finish({ ok: true, title: info.title, thumbnailUrl: info.thumbnail, formats });
    } catch (e) {
      finish({ ok: false, error: `Разбор ответа yt-dlp: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}

// ---------- Обложка страницы ----------

function startThumbnail(req: ThumbnailJobRequest): void {
  let outFile: string;
  let stemPath: string;
  try {
    const outDir = resolveOutDir(req.outDir);
    outFile = uniquePath(outDir, `${req.filenameStem}.jpg`);
    stemPath = outFile.slice(0, -4); // без .jpg — расширение допишет yt-dlp
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const args = [
    ...YTDLP_COMMON_ARGS, '--no-playlist', '--skip-download',
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', `thumbnail:${stemPath}.%(ext)s`,
  ];
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  args.push(req.pageUrl);

  log('thumbnail start', req.jobId, req.pageUrl, '->', outFile);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let errTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });
  child.on('error', (e) => {
    jobs.delete(req.jobId);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить yt-dlp: ${e.message}` });
  });
  child.on('close', (code) => {
    log('thumbnail exit', req.jobId, code, 'canceled:', job.canceled);
    // Конвертер мог оставить исходник (.webp) рядом — не мусорим
    for (const ext of ['webp', 'png']) {
      fs.rm(`${stemPath}.${ext}`, { force: true }, () => {});
    }
    if (!job.canceled && code === 0 && !fs.existsSync(outFile)) {
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: 'У страницы не нашлось обложки' });
      return;
    }
    jobDone(req.jobId, code, { canceled: job.canceled }, outFile, errTail);
  });
}

// ---------- Кадры-превью ----------

// Не даём ffmpeg разгуляться: превью — фон, загрузки важнее
const THUMB_CONCURRENCY = 2;
const THUMB_TIMEOUT_MS = 20_000;
const thumbQueue: ThumbRequest[] = [];
let thumbActive = 0;

function enqueueThumb(req: ThumbRequest): void {
  thumbQueue.push(req);
  pumpThumbs();
}

function pumpThumbs(): void {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const req = thumbQueue.shift()!;
    thumbActive++;
    runThumb(req, () => {
      thumbActive--;
      pumpThumbs();
    });
  }
}

function runThumb(req: ThumbRequest, done: () => void): void {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (req.headers?.userAgent) args.push('-user_agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('-referer', req.headers.referer);
  args.push(
    '-ss', '1',
    '-i', req.url,
    '-frames:v', '1',
    '-vf', 'scale=192:-2',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-q:v', '5',
    'pipe:1',
  );

  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const chunks: Buffer[] = [];
  let finished = false;
  const finish = (dataUrl: string | null): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    sendMessage({ type: 'thumb', reqId: req.reqId, dataUrl });
    done();
  };
  const timer = setTimeout(() => {
    log('thumb timeout', req.url);
    child.kill('SIGKILL');
  }, THUMB_TIMEOUT_MS);

  child.stdout?.on('data', (d: Buffer) => chunks.push(d));
  child.on('error', (e) => {
    log('thumb spawn error', e.message);
    finish(null);
  });
  child.on('close', (code) => {
    const buf = Buffer.concat(chunks);
    finish(code === 0 && buf.length > 0 ? `data:image/jpeg;base64,${buf.toString('base64')}` : null);
  });
}

function pickDir(req: PickDirRequest): void {
  // Диалог выбора папки — через PowerShell (WinForms). Асинхронно, чтобы
  // не блокировать прогресс идущих загрузок, пока диалог открыт.
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = 'Папка загрузок YaDaun'",
    '$f.ShowNewFolderButton = $true',
    'if ($env:DOWNY_CURRENT_DIR -and (Test-Path -LiteralPath $env:DOWNY_CURRENT_DIR)) { $f.SelectedPath = $env:DOWNY_CURRENT_DIR }',
    // TopMost-владелец, иначе диалог откроется позади браузера
    '$w = New-Object System.Windows.Forms.Form',
    '$w.TopMost = $true',
    "if ($f.ShowDialog($w) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }",
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, DOWNY_CURRENT_DIR: req.current ?? '' },
  });
  // Пока диалог открыт, шлём heartbeat — иначе Chrome усыпит service worker
  const heartbeat = setInterval(() => sendMessage({ type: 'heartbeat' }), 10_000);
  let out = '';
  let finished = false;
  const finish = (dir: string | null): void => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    log('pick_dir result', dir ?? '(отмена)');
    sendMessage({ type: 'pick_dir', reqId: req.reqId, dir });
  };
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.on('error', (e) => {
    log('pick_dir spawn error', e.message);
    finish(null);
  });
  child.on('close', () => {
    finish(out.trim() || null);
  });
}

function showInFolder(target: string): void {
  log('show_in_folder', target);
  // Файл могли переместить/удалить — тогда открываем хотя бы папку.
  // Кавычки ставим сами: авто-квотирование Node оборачивает «/select,путь»
  // целиком, explorer такое не понимает и молча открывает «Документы».
  const arg = fs.existsSync(target) ? `/select,"${target}"` : `"${path.dirname(target)}"`;
  spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

// ---------- Самообновление ----------

const REPO = 'dimalebedeff/downy';
// Корень установки (папка с package.json и build.mjs)
const installRoot = path.join(coappRoot, '..');
// Список файлов, приехавших из релиза при прошлом обновлении, — чтобы при
// следующем удалить те, которых в новом релизе больше нет (cpSync сам не удаляет)
const updateFilesManifest = path.join(installRoot, '.update-files.json');

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

/** Удаляет файлы прошлого релиза, исчезнувшие в новом. Никогда не трогает
 *  сгенерированное (node_modules, dist, bin, логи) — их в списках релизов нет. */
function pruneRemovedFiles(newFiles: string[]): void {
  let prev: string[];
  try {
    prev = JSON.parse(fs.readFileSync(updateFilesManifest, 'utf8')) as string[];
  } catch {
    prev = []; // первого списка ещё нет — удалять нечего
  }
  const fresh = new Set(newFiles);
  for (const rel of prev) {
    if (fresh.has(rel)) continue;
    const target = path.resolve(installRoot, rel);
    // Страховка от выхода за пределы установки (кривой список и т.п.)
    if (!target.startsWith(installRoot + path.sep)) continue;
    try {
      fs.rmSync(target, { force: true });
      log('update: pruned', rel);
    } catch {
      // занятый файл удалим при следующем обновлении
    }
  }
  fs.writeFileSync(updateFilesManifest, JSON.stringify(newFiles));
}

function runStep(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let errTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-1000);
    });
    child.on('error', (e) => resolve(`не удалось запустить ${cmd}: ${e.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : errTail || `${cmd}: exit code ${code}`));
  });
}

async function runUpdate(req: UpdateRequest): Promise<void> {
  const emitUpdate = (state: 'downloading' | 'installing' | 'done' | 'error', message?: string): void => {
    sendMessage({ type: 'update', reqId: req.reqId, state, message });
  };
  if (jobs.size > 0) {
    emitUpdate('error', 'Дождись окончания загрузок');
    return;
  }
  // npm install может идти минуту — не даём Chrome усыпить service worker
  const heartbeat = setInterval(() => sendMessage({ type: 'heartbeat' }), 10_000);
  const tmpDir = path.join(os.tmpdir(), `downy-update-${Date.now()}`);
  try {
    // Тег приходит из GitHub API, но в URL он попадает только валидным
    if (!/^v?[\w.-]+$/.test(req.tag)) throw new Error(`подозрительный тег: ${req.tag}`);
    log('update start', req.tag);
    emitUpdate('downloading');
    const zipPath = path.join(tmpDir, 'downy.zip');
    fs.mkdirSync(tmpDir, { recursive: true });
    const resp = await fetch(`https://codeload.github.com/${REPO}/zip/refs/tags/${req.tag}`, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`GitHub ответил HTTP ${resp.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await resp.arrayBuffer()));

    const extractDir = path.join(tmpDir, 'src');
    const unzipErr = await runStep('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], tmpDir);
    if (unzipErr) throw new Error(`распаковка: ${unzipErr}`);
    // Внутри zipball один корневой каталог вида downy-0.4
    const [srcRoot] = fs.readdirSync(extractDir).map((n) => path.join(extractDir, n));
    if (!srcRoot || !fs.existsSync(path.join(srcRoot, 'package.json'))) {
      throw new Error('в архиве нет package.json — неожиданная структура');
    }

    emitUpdate('installing');
    // Копируем исходники поверх установки; dist и bin архив не содержит,
    // поэтому работающая версия остаётся целой до успешной сборки ниже
    fs.cpSync(srcRoot, installRoot, { recursive: true, force: true });
    const npmErr = await runStep('cmd.exe', ['/c', 'npm', 'install', '--no-audit', '--no-fund'], installRoot);
    if (npmErr) throw new Error(`npm install: ${npmErr}`);
    const buildErr = await runStep(process.execPath, ['build.mjs'], installRoot);
    if (buildErr) throw new Error(`сборка: ${buildErr}`);

    // Только после успешной сборки: при провале старые файлы не трогаем
    pruneRemovedFiles(listFilesRecursive(srcRoot));

    // Свежий yt-dlp важен (сайты ломают экстракторы), но его сбой не фатален
    const ytdlpErr = await runStep(ytdlpPath, ['-U'], installRoot);
    if (ytdlpErr) log('update: yt-dlp -U failed (non-fatal):', ytdlpErr.slice(-300));

    log('update done', req.tag);
    emitUpdate('done');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('update error', msg);
    emitUpdate('error', msg);
  } finally {
    clearInterval(heartbeat);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

function cancel(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.canceled = true;
  log('cancel', jobId);
  job.kill();
}

function pause(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.paused = true;
  log('pause', jobId);
  job.kill();
}

process.on('uncaughtException', (e) => log('uncaught', e.stack ?? e.message));

readMessages((raw) => {
  const msg = raw as CoAppRequest;
  log('recv', JSON.stringify(msg).slice(0, 300));
  switch (msg.type) {
    case 'ping':
      sendMessage({
        type: 'pong',
        version: VERSION,
        ffmpeg: binWorks(ffmpegPath, '-version'),
        ytdlp: binWorks(ytdlpPath, '--version'),
        defaultOutDir,
      });
      break;
    case 'pick_dir':
      pickDir(msg);
      break;
    case 'thumb':
      enqueueThumb(msg);
      break;
    case 'show_in_folder':
      showInFolder(msg.path);
      break;
    case 'download_hls':
      startHls(msg);
      break;
    case 'download_direct':
      void startDirect(msg);
      break;
    case 'download_ytdlp':
      startYtdlp(msg);
      break;
    case 'download_thumbnail':
      startThumbnail(msg);
      break;
    case 'probe':
      probe(msg);
      break;
    case 'cancel':
      cancel(msg.jobId);
      break;
    case 'pause':
      pause(msg.jobId);
      break;
    case 'cleanup_partials':
      // Отмена паузы: убрать недокачанный файл и хвосты yt-dlp
      cleanupPartials(msg.path);
      break;
    case 'update':
      void runUpdate(msg);
      break;
  }
});

log('coapp started, ffmpeg:', ffmpegPath, 'yt-dlp:', ytdlpPath);
