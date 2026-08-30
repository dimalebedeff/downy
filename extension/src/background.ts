import { classifyMedia, isProbablyVideo } from './lib/media-detect';
import { canonicalMediaUrl, sniffMuted, stripHash } from './lib/media-group';
import { isMasterPlaylist, looksLikePlaylist, parseMasterPlaylist, playlistDuration } from './lib/m3u8';
import { looksLikeMpd, mpdDuration } from './lib/mpd';
import { buildFilename, buildYtdlpStem } from './lib/filename';
import { isNewerVersion, REPO } from './lib/update';
import { applyReorder, isUnfinished, nextToStart, normalizeOrder } from './lib/queue';
import { nextSpeed, type SpeedTrack } from './lib/speed';
import { withCutSuffix } from './lib/cut';
import { qualityOptions } from './lib/ytdlp-formats';
import { assetIds, imageStem, previewSiblings } from './lib/pick';
import type { JobInfo, MediaItem, ProbeState } from './lib/types';
import type {
  CoAppEvent,
  CoAppRequest,
  CutRange,
  DirectJobRequest,
  HlsJobRequest,
  PongEvent,
  StreamSelection,
  YtdlpJobRequest,
} from '../../shared/protocol';

const NATIVE_HOST = 'com.downy.coapp';

// ---------- Состояние ----------

const tabMedia = new Map<number, Map<string, MediaItem>>();
// URL дочерних плейлистов известных мастеров — их не показываем отдельно
const tabVariantUrls = new Map<number, Set<string>>();
// Обложка страницы (og:image) — превью-фолбэк для медиа, найденного по сети
const tabPageThumb = new Map<number, string>();
// Страницы с MSE-видео (blob:) — файл по сети не взять, предлагаем yt-dlp
interface PageVideo {
  /** Что качать yt-dlp: ссылка поста из ленты либо адрес страницы */
  url: string;
  /** Адрес вкладки, где видео нашли, — по нему попап решает, показывать ли карточку */
  pageHref?: string;
  title?: string;
  thumb?: string;
}
/** Видео-посты вкладки: url поста → карточка. Копятся при скролле ленты,
 *  чтобы проскролленное не пропадало из попапа. */
const tabPageVideos = new Map<number, Map<string, PageVideo>>();
const PAGE_VIDEOS_MAX = 10;
/** Убранные крестиком находки — не возвращаются до перезагрузки вкладки */
const tabRemoved = new Map<number, Set<string>>();
const jobs = new Map<string, JobInfo>();
const inflightHls = new Set<string>();

// ---------- Очередь: качается одна, остальные ждут ----------

/** Порядок незавершённых загрузок; голова — активная */
let queueOrder: string[] = [];
/** Замеры скорости по джобам; живёт в памяти SW — после рестарта пересчитается */
const speedTracks = new Map<string, SpeedTrack>();
/** Исходные запросы к CoApp — для отложенного старта и резюма после паузы */
const jobRequests = new Map<string, CoAppRequest>();

/** Джобы для попапа: очередь в своём порядке, потом обложки и завершённые */
function jobList(): JobInfo[] {
  const orderIdx = new Map(queueOrder.map((id, i) => [id, i]));
  return [...jobs.values()].sort((a, b) => {
    const ai = isUnfinished(a.state) ? orderIdx.get(a.jobId) ?? 1e9 : 2e9;
    const bi = isUnfinished(b.state) ? orderIdx.get(b.jobId) ?? 1e9 : 2e9;
    return ai - bi;
  });
}

/** Двигает очередь: если активной нет — стартует следующую (или резюмит вытесненную).
 *  Идемпотентна и дёшева — можно дёргать при любом удобном случае. */
function pump(): void {
  queueOrder = normalizeOrder(queueOrder, jobs);
  const id = nextToStart(queueOrder, jobs);
  if (!id) return;
  const job = jobs.get(id)!;
  const req = jobRequests.get(id);
  if (!req) {
    job.state = 'error';
    job.message = 'Запрос загрузки потерялся при перезапуске';
    pump();
    return;
  }
  // Недокачанный файл от паузы — продолжаем его, а не начинаем новый
  if (job.outFile && (req.type === 'download_hls' || req.type === 'download_direct' || req.type === 'download_ytdlp')) {
    (req as HlsJobRequest | DirectJobRequest | YtdlpJobRequest).resumePath = job.outFile;
  }
  job.state = 'starting';
  job.pausedBy = undefined;
  const res = sendToCoApp(req);
  if (!res.ok) {
    // CoApp лежит — остальную очередь не мучаем, юзер увидит ошибку на первой
    job.state = 'error';
    job.message = res.error;
  }
  persist();
  broadcastJobs();
}

/** Лёгкое (обложки, мелкое аудио) не ждёт в очереди за двухгиговым кино */
const NO_QUEUE_MAX_BYTES = 250 * 1024 * 1024;

/** Ставит загрузку в очередь; noQueue-мелочь стартует сразу и параллельно */
function enqueueJob(job: JobInfo, req: CoAppRequest): void {
  log('bg', `queued ${job.jobId} ${job.label}${job.noQueue ? ' (мимо очереди)' : ''}`);
  jobs.set(job.jobId, job);
  jobRequests.set(job.jobId, req);
  if (job.noQueue) {
    job.state = 'starting';
    const res = sendToCoApp(req);
    if (!res.ok) {
      job.state = 'error';
      job.message = res.error;
    }
    persist();
    broadcastJobs();
    return;
  }
  queueOrder.push(job.jobId);
  pump();
  broadcastJobs();
}

// Service worker может быть выгружен в любой момент — состояние живёт в storage.session
const restored: Promise<void> = (async () => {
  const data = await chrome.storage.session.get([
    'tabMedia', 'jobs', 'tabVariantUrls', 'tabPageThumb', 'tabPageVideos', 'tabRemoved', 'queueOrder', 'jobRequests',
  ]);
  if (data.tabPageThumb) {
    for (const [tabId, thumb] of Object.entries(data.tabPageThumb as Record<string, string>)) {
      tabPageThumb.set(Number(tabId), thumb);
    }
  }
  if (data.tabPageVideos) {
    for (const [tabId, vids] of Object.entries(data.tabPageVideos as Record<string, Record<string, PageVideo>>)) {
      // Старые записи ключевались URL с хэшем — схлопываем дубли одного видео
      const m = new Map<string, PageVideo>();
      for (const v of Object.values(vids)) {
        const key = stripHash(v.url);
        const existing = m.get(key);
        if (existing) {
          existing.thumb ??= v.thumb;
          existing.title ??= v.title;
        } else {
          m.set(key, { ...v, url: key });
        }
      }
      tabPageVideos.set(Number(tabId), m);
    }
  }
  if (data.tabRemoved) {
    for (const [tabId, urls] of Object.entries(data.tabRemoved as Record<string, string[]>)) {
      tabRemoved.set(Number(tabId), new Set(urls.map(stripHash)));
    }
  }
  if (data.tabMedia) {
    for (const [tabId, items] of Object.entries(data.tabMedia as Record<string, Record<string, MediaItem>>)) {
      tabMedia.set(Number(tabId), new Map(Object.entries(items)));
    }
  }
  if (data.tabVariantUrls) {
    for (const [tabId, urls] of Object.entries(data.tabVariantUrls as Record<string, string[]>)) {
      tabVariantUrls.set(Number(tabId), new Set(urls));
    }
  }
  if (data.jobRequests) {
    for (const [id, req] of Object.entries(data.jobRequests as Record<string, CoAppRequest>)) {
      jobRequests.set(id, req);
    }
  }
  if (data.jobs) {
    for (const [id, job] of Object.entries(data.jobs as Record<string, JobInfo>)) {
      // Рестарт SW закрыл порт, CoApp вместе с загрузками умер. Если запрос
      // сохранился — ставим на паузу (докачается), иначе честная ошибка
      if (job.state === 'running' || job.state === 'starting') {
        if (jobRequests.has(id)) {
          job.state = 'paused';
          job.pausedBy = 'user';
        } else {
          job.state = 'error';
          job.message = 'Прервано перезапуском браузера';
        }
      }
      jobs.set(id, job);
    }
  }
  queueOrder = normalizeOrder((data.queueOrder as string[]) ?? [], jobs);
})();

// После рестарта SW очередь продолжает ехать сама
void restored.then(() => pump());

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const tm: Record<string, Record<string, MediaItem>> = {};
    for (const [tabId, items] of tabMedia) tm[tabId] = Object.fromEntries(items);
    const tv: Record<string, string[]> = {};
    for (const [tabId, urls] of tabVariantUrls) tv[tabId] = [...urls];
    const tpv: Record<string, Record<string, PageVideo>> = {};
    for (const [tabId, vids] of tabPageVideos) tpv[tabId] = Object.fromEntries(vids);
    const trm: Record<string, string[]> = {};
    for (const [tabId, urls] of tabRemoved) trm[tabId] = [...urls];
    void chrome.storage.session.set({
      tabMedia: tm,
      tabVariantUrls: tv,
      tabPageThumb: Object.fromEntries(tabPageThumb),
      tabPageVideos: tpv,
      tabRemoved: trm,
      jobs: Object.fromEntries(jobs),
      queueOrder,
      jobRequests: Object.fromEntries(jobRequests),
    });
  }, 300);
}

function getTabItems(tabId: number): Map<string, MediaItem> {
  let m = tabMedia.get(tabId);
  if (!m) {
    m = new Map();
    tabMedia.set(tabId, m);
  }
  return m;
}

function clearTab(tabId: number): void {
  tabMedia.delete(tabId);
  tabVariantUrls.delete(tabId);
  tabPageThumb.delete(tabId);
  tabPageVideos.delete(tabId);
  tabRemoved.delete(tabId);
  // Новая страница — новый контент-скрипт, и прицел в нём выключен. Не забыть
  // об этом здесь значило бы, что первый Alt+Shift+D после F5 «выключает»
  // то, чего уже нет, и режим включается лишь со второго нажатия
  if (pickCounts.delete(tabId)) log('bg', `прицел сброшен навигацией, вкладка ${tabId}`);
  persist();
}

// ---------- Детекция ----------

async function pageInfo(tabId: number): Promise<{ pageUrl?: string; pageTitle?: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { pageUrl: tab?.url, pageTitle: tab?.title };
}

function upsertItem(item: MediaItem): void {
  // Ленты типа X: сниффер ловит рекламу и проскролленное — не показываем,
  // скачивание там идёт через карточку поста (yt-dlp)
  if (sniffMuted(item.pageUrl)) return;
  // Убранное крестиком не возвращаем
  if (tabRemoved.get(item.tabId)?.has(item.url)) return;
  const items = getTabItems(item.tabId);
  const existing = items.get(item.url);
  if (existing) {
    if (item.size && !existing.size) existing.size = item.size;
    if (item.contentType && !existing.contentType) existing.contentType = item.contentType;
    if (item.pageTitle && !existing.pageTitle) existing.pageTitle = item.pageTitle;
    if (item.thumb && !existing.thumb) existing.thumb = item.thumb;
    persist();
    return;
  }
  items.set(item.url, item);
  persist();
}

async function addDirect(
  tabId: number,
  url: string,
  contentType?: string,
  size?: number,
  pageTitle?: string,
  thumb?: string,
): Promise<void> {
  await restored;
  if (getTabItems(tabId).has(url)) {
    upsertItem({ url, kind: 'direct', tabId, foundAt: Date.now(), contentType, size, thumb });
    return;
  }
  const info = await pageInfo(tabId);
  upsertItem({
    url,
    kind: 'direct',
    tabId,
    foundAt: Date.now(),
    contentType,
    size,
    thumb,
    pageUrl: info.pageUrl,
    pageTitle: pageTitle ?? info.pageTitle,
  });
}

async function addHls(tabId: number, url: string, pageTitle?: string, thumb?: string): Promise<void> {
  await restored;
  if (tabVariantUrls.get(tabId)?.has(url)) return;
  if (getTabItems(tabId).has(url)) return;
  const inflightKey = `${tabId}:${url}`;
  if (inflightHls.has(inflightKey)) return;
  inflightHls.add(inflightKey);
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return;
    const text = await resp.text();
    if (!looksLikePlaylist(text)) return;
    const info = await pageInfo(tabId);
    const base: MediaItem = {
      url,
      kind: 'hls',
      tabId,
      foundAt: Date.now(),
      thumb,
      pageUrl: info.pageUrl,
      pageTitle: pageTitle ?? info.pageTitle,
    };
    if (isMasterPlaylist(text)) {
      const variants = parseMasterPlaylist(text, resp.url || url);
      let known = tabVariantUrls.get(tabId);
      if (!known) {
        known = new Set();
        tabVariantUrls.set(tabId, known);
      }
      const items = getTabItems(tabId);
      for (const v of variants) {
        known.add(v.url);
        items.delete(v.url); // дочерний плейлист мог успеть попасть в список раньше мастера
      }
      upsertItem({ ...base, variants });
    } else {
      const durationSec = playlistDuration(text) || undefined;
      upsertItem({ ...base, durationSec });
    }
  } catch {
    // сеть/CORS — просто не показываем этот плейлист
  } finally {
    inflightHls.delete(inflightKey);
  }
}

async function addDash(tabId: number, url: string, pageTitle?: string, thumb?: string): Promise<void> {
  await restored;
  if (getTabItems(tabId).has(url)) return;
  const inflightKey = `${tabId}:${url}`;
  if (inflightHls.has(inflightKey)) return;
  inflightHls.add(inflightKey);
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return;
    const text = await resp.text();
    if (!looksLikeMpd(text)) return;
    const info = await pageInfo(tabId);
    upsertItem({
      url,
      kind: 'dash',
      tabId,
      foundAt: Date.now(),
      thumb,
      pageUrl: info.pageUrl,
      pageTitle: pageTitle ?? info.pageTitle,
      durationSec: mpdDuration(text) ?? undefined,
    });
  } catch {
    // сеть/CORS — просто не показываем этот манифест
  } finally {
    inflightHls.delete(inflightKey);
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const header = (name: string) =>
      details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
    const contentType = header('content-type');
    const kind = classifyMedia(details.url, contentType);
    if (!kind) return;
    if (kind === 'hls') {
      void addHls(details.tabId, details.url);
      return;
    }
    if (kind === 'dash') {
      void addDash(details.tabId, details.url);
      return;
    }
    let size: number | undefined;
    if (details.statusCode === 206) {
      const m = header('content-range')?.match(/\/(\d+)\s*$/);
      if (m) size = parseInt(m[1], 10);
    } else {
      const cl = header('content-length');
      if (cl) size = parseInt(cl, 10);
    }
    // Куски одного файла (?bytes=...) схлопываем в один элемент с полным URL
    void addDirect(details.tabId, canonicalMediaUrl(details.url), contentType ?? undefined, size);
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') clearTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
});

// ---------- CoApp (Native Messaging) ----------

let coappPort: chrome.runtime.Port | null = null;

// Ожидающие ответы диалога выбора папки: reqId -> resolve
const pendingPickDir = new Map<string, (res: { dir: string | null; error?: string }) => void>();

// Запрошенные у CoApp кадры-превью: reqId -> куда положить результат
const pendingThumbs = new Map<string, { tabId: number; url: string }>();

// ---------- Разведка форматов (кеш по URL страницы) ----------

const probeCache = new Map<string, ProbeState>();
const pendingProbes = new Map<string, string>(); // reqId -> pageUrl

/** Запускает разведку, если её ещё не было; отвечает текущим состоянием. */
function ensureProbe(pageUrl: string): ProbeState {
  const cached = probeCache.get(pageUrl);
  if (cached) return cached;
  const reqId = crypto.randomUUID();
  pendingProbes.set(reqId, pageUrl);
  const pending: ProbeState = { status: 'pending' };
  probeCache.set(pageUrl, pending);
  const res = sendToCoApp({ type: 'probe', reqId, pageUrl });
  if (!res.ok) {
    pendingProbes.delete(reqId);
    probeCache.delete(pageUrl);
    return { status: 'error', error: res.error };
  }
  return pending;
}
// Ожидающие ответа ping (проверка статуса из попапа)
const pendingPings = new Set<(res: { ok: boolean; info?: PongEvent; error?: string }) => void>();
// URL, по которым кадр уже запрашивали (успех или отказ) — не долбим ffmpeg повторно
const thumbTried = new Set<string>();

function getCoAppPort(): chrome.runtime.Port {
  if (coappPort) return coappPort;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener((msg: CoAppEvent) => {
    if (msg.type === 'pick_dir') {
      const resolve = pendingPickDir.get(msg.reqId);
      pendingPickDir.delete(msg.reqId);
      resolve?.({ dir: msg.dir });
      return;
    }
    if (msg.type === 'heartbeat') return; // само получение сбрасывает таймер простоя SW
    if (msg.type === 'pong') {
      for (const resolve of pendingPings) resolve({ ok: true, info: msg });
      pendingPings.clear();
      return;
    }
    if (msg.type === 'update') {
      broadcastUpdateProgress(msg.state, msg.message);
      if (msg.state === 'done') {
        updateInProgress = false;
        // Даём попапу секунду показать «Готово» — и перечитываем extension/dist с диска
        setTimeout(() => chrome.runtime.reload(), 1000);
      } else if (msg.state === 'error') {
        updateInProgress = false;
      }
      return;
    }
    if (msg.type === 'probe') {
      const url = pendingProbes.get(msg.reqId);
      pendingProbes.delete(msg.reqId);
      if (!url) return;
      probeCache.set(
        url,
        msg.ok
          ? { status: 'ready', title: msg.title, thumbnailUrl: msg.thumbnailUrl, formats: msg.formats ?? [] }
          : { status: 'error', error: msg.error },
      );
      return;
    }
    if (msg.type === 'thumb') {
      const target = pendingThumbs.get(msg.reqId);
      pendingThumbs.delete(msg.reqId);
      if (target && msg.dataUrl) {
        const item = tabMedia.get(target.tabId)?.get(target.url);
        if (item && !item.thumb) {
          item.thumb = msg.dataUrl;
          persist();
        }
      }
      return;
    }
    if (msg.type !== 'job') return;
    const job = jobs.get(msg.jobId);
    if (!job) return;
    if (msg.state !== job.state) {
      log('bg', `job ${msg.jobId} ${job.state} -> ${msg.state}${msg.message ? ` (${msg.message.slice(0, 200)})` : ''}`);
    }
    job.state = msg.state;
    // Пауза шлёт progress: null — не стираем позицию полоски
    if (msg.state !== 'paused' || msg.progress != null) job.progress = msg.progress;
    job.message = msg.message;
    if (msg.bytes != null) job.bytes = msg.bytes;
    if (msg.totalBytes != null) job.totalBytes = msg.totalBytes;
    if (msg.state === 'running' && msg.bytes != null) {
      const track = nextSpeed(speedTracks.get(msg.jobId), msg.bytes, Date.now());
      speedTracks.set(msg.jobId, track);
      job.speedBps = track.bps;
    } else if (msg.state !== 'running') {
      speedTracks.delete(msg.jobId);
      job.speedBps = undefined;
    }
    if (msg.outFile) job.outFile = msg.outFile;
    if (msg.state === 'done' || msg.state === 'error' || msg.state === 'canceled') {
      job.finishedAt = Date.now();
      jobRequests.delete(msg.jobId);
    }
    persist();
    broadcastJobs();
    // Место освободилось (готово/ошибка/отмена/пауза) — очередь едет дальше
    if (msg.state !== 'running') pump();
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    log('bg', `coapp отключился: ${err ?? '(без причины)'}`);
    coappPort = null;
    if (updateInProgress) {
      updateInProgress = false;
      broadcastUpdateProgress('error', err ?? 'CoApp отключился во время обновления');
    }
    for (const resolve of pendingPickDir.values()) resolve({ dir: null, error: err ?? 'CoApp отключился' });
    pendingPickDir.clear();
    for (const resolve of pendingPings) resolve({ ok: false, error: err ?? 'CoApp не установлен' });
    pendingPings.clear();
    // Дадим шанс перезапросить кадры при следующем открытии попапа
    for (const { url } of pendingThumbs.values()) thumbTried.delete(url);
    pendingThumbs.clear();
    // Зависшие разведки — тоже на повтор
    for (const url of pendingProbes.values()) probeCache.delete(url);
    pendingProbes.clear();
    for (const job of jobs.values()) {
      if (job.state === 'running' || job.state === 'starting') {
        // Запрос сохранился — паузим, юзер продолжит кнопкой; авторесюм
        // не делаем, чтобы упавший хост не перезапускался по кругу
        if (jobRequests.has(job.jobId) && !job.noQueue) {
          job.state = 'paused';
          job.pausedBy = 'user';
          job.message = err ?? 'CoApp отключился';
        } else {
          job.state = 'error';
          job.message = err ?? 'CoApp отключился';
        }
      }
    }
    persist();
    broadcastJobs();
  });
  coappPort = port;
  return port;
}

/** Загрузки, начатые прямо со страницы (прицел, контекстное меню). Попап при
 *  этом закрыт, поэтому о ходе дела странице рассказываем отдельно — иначе
 *  клик выглядит так, будто ничего не произошло. */
const pageJobs = new Map<number, Set<string>>();

function trackPageJob(tabId: number, jobId: string): void {
  const ids = pageJobs.get(tabId) ?? new Set<string>();
  ids.add(jobId);
  pageJobs.set(tabId, ids);
}

function pushPageJobs(): void {
  for (const [tabId, ids] of [...pageJobs]) {
    const mine = jobList().filter((j) => ids.has(j.jobId));
    if (mine.length === 0) {
      pageJobs.delete(tabId);
      continue;
    }
    void chrome.tabs.sendMessage(tabId, { type: 'page-jobs', jobs: mine }).catch(() => {});
    // Завершённое отправили — дальше о нём рассказывать нечего
    for (const job of mine) {
      if (!isUnfinished(job.state)) ids.delete(job.jobId);
    }
    if (ids.size === 0) pageJobs.delete(tabId);
  }
}

function broadcastJobs(): void {
  void chrome.runtime.sendMessage({ type: 'jobs-updated', jobs: jobList() }).catch(() => {});
  pushPageJobs();
}

/** Событие расширения в общий coapp.log. Порт намеренно не поднимаем: логи —
 *  не повод будить хост, а без хоста всё равно ничего не качается. */
function log(source: 'popup' | 'bg' | 'page', message: string): void {
  if (!coappPort) return;
  try {
    coappPort.postMessage({ type: 'log', source, message });
  } catch {
    // лог не критичен
  }
}

function sendToCoApp(req: CoAppRequest): { ok: boolean; error?: string } {
  try {
    getCoAppPort().postMessage(req);
    return { ok: true };
  } catch (e) {
    coappPort = null;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Пингуем через основной порт: не плодим второй процесс хоста на каждый попап
function pingCoApp(): Promise<{ ok: boolean; info?: PongEvent; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res: { ok: boolean; info?: PongEvent; error?: string }): void => {
      if (settled) return;
      settled = true;
      pendingPings.delete(done);
      clearTimeout(timer);
      resolve(res);
    };
    // Хост однопоточный: пока он парсит плейлист или разбирает вывод yt-dlp,
    // ответ на ping ждёт своей очереди. Три секунды тут ловили живого помощника
    const timer = setTimeout(() => done({ ok: false, error: 'CoApp не ответил за 8 секунд' }), 8000);
    pendingPings.add(done);
    const sent = sendToCoApp({ type: 'ping' });
    if (!sent.ok) done({ ok: false, error: sent.error ?? 'CoApp не установлен' });
  });
}

/** Просит CoApp вытащить кадр для элемента без превью (лениво, при открытом попапе). */
function requestThumb(item: MediaItem): void {
  if (item.thumb || thumbTried.has(item.url)) return;
  // Стримы считаем видео; для прямых файлов кадр имеет смысл только у видео
  if (item.kind === 'direct' && !isProbablyVideo(item.url, item.contentType)) return;
  thumbTried.add(item.url);
  const reqId = crypto.randomUUID();
  pendingThumbs.set(reqId, { tabId: item.tabId, url: item.url });
  const res = sendToCoApp({
    type: 'thumb',
    reqId,
    url: item.url,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  if (!res.ok) {
    pendingThumbs.delete(reqId);
    thumbTried.delete(item.url);
  }
}

/** Нативный диалог выбора папки через CoApp */
function pickDirDialog(current?: string): Promise<{ dir: string | null; error?: string }> {
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    pendingPickDir.set(reqId, resolve);
    const sent = sendToCoApp({ type: 'pick_dir', reqId, current });
    if (!sent.ok) {
      pendingPickDir.delete(reqId);
      resolve({ dir: null, error: sent.error ?? 'CoApp недоступен' });
    }
    // Страховка: если CoApp так и не ответил, не держим промис вечно
    setTimeout(() => {
      const resolveTimeout = pendingPickDir.get(reqId);
      pendingPickDir.delete(reqId);
      resolveTimeout?.({ dir: null, error: 'Диалог выбора папки не ответил' });
    }, 300_000);
  });
}

/** Папка для новой загрузки; с галочкой «спрашивать каждый раз» — диалог */
async function resolveJobOutDir(): Promise<{ dir?: string; canceled?: boolean; error?: string }> {
  const { outDir, askDirEveryTime } = await chrome.storage.local.get({ outDir: '', askDirEveryTime: false });
  const saved = (outDir as string).trim() || undefined;
  if (!askDirEveryTime) return { dir: saved };
  const res = await pickDirDialog(saved);
  if (res.error) return { error: res.error };
  if (!res.dir) return { canceled: true }; // юзер закрыл диалог — передумал качать
  return { dir: res.dir };
}

/** Ответ попапу на «Скачать»: jobId есть — джоба встала в очередь и её
 *  можно ждать в списке; jobId нет — старт отменили (диалог папки) или ошибка. */
interface StartJobResult {
  ok: boolean;
  error?: string;
  jobId?: string;
}

async function startHlsJob(
  item: MediaItem,
  variantUrl?: string,
  variantLabel?: string,
  streams: StreamSelection = 'both',
  cut?: CutRange,
): Promise<StartJobResult> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  const filename = withCutSuffix(buildFilename(item, variantLabel, streams), cut);
  const job: JobInfo = {
    jobId,
    label: filename,
    state: 'queued',
    progress: null,
    sourceUrl: item.url,
    mediaKind: streams === 'audio' ? 'audio' : 'video',
  };
  enqueueJob(job, {
    type: 'download_hls',
    jobId,
    url: variantUrl ?? item.url,
    filename,
    outDir: dir.dir,
    streams,
    cut,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  return { ok: true, jobId };
}

async function startDirectJob(
  item: MediaItem,
  streams: StreamSelection = 'both',
  cut?: CutRange,
): Promise<StartJobResult> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  const filename = withCutSuffix(buildFilename(item, undefined, streams), cut);
  const ct = (item.contentType ?? '').toLowerCase();
  // Мелочь мимо очереди: картинки-обложки и аудио с известным скромным весом
  const audioIntent = streams === 'audio' || ct.startsWith('audio');
  const noQueue =
    ct.startsWith('image') || (audioIntent && item.size != null && item.size <= NO_QUEUE_MAX_BYTES) || undefined;
  const job: JobInfo = {
    jobId,
    label: filename,
    state: 'queued',
    progress: null,
    // У отрезка вес неизвестен заранее — полный размер файла не про него
    totalBytes: streams === 'both' && !cut ? item.size : undefined,
    sourceUrl: item.url,
    noQueue,
    mediaKind: ct.startsWith('image') ? 'image' : audioIntent ? 'audio' : 'video',
  };
  enqueueJob(job, {
    type: 'download_direct',
    jobId,
    url: item.url,
    filename,
    outDir: dir.dir,
    streams,
    cut,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  return { ok: true, jobId };
}

async function startYtdlpJob(
  pageUrl: string,
  pageTitle?: string,
  streams: StreamSelection = 'both',
  maxHeight?: number,
  qualityLabel?: string,
  cut?: CutRange,
): Promise<StartJobResult> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  // Название знаем из разведки — имя собираем сами (с датой и страховкой
  // от перезаписи на хосте); разведки нет — yt-dlp именует по шаблону
  const probed = probeCache.get(pageUrl);
  const ready = probed?.status === 'ready' ? probed : undefined;
  const title = ready?.title ?? pageTitle;
  const stem = title ? buildYtdlpStem(title, pageUrl, qualityLabel, streams) : undefined;
  const filenameStem = stem ? withCutSuffix(stem, cut) : undefined;
  // Скромное аудио (вес знаем из разведки) не ждёт очередь
  let noQueue: boolean | undefined;
  if (streams === 'audio' && ready) {
    let best = 0;
    for (const f of ready.formats) {
      if (!f.hasVideo && f.hasAudio && f.sizeBytes && f.sizeBytes > best) best = f.sizeBytes;
    }
    if (best > 0 && best <= NO_QUEUE_MAX_BYTES) noQueue = true;
  }
  const job: JobInfo = {
    jobId,
    label: filenameStem ?? `yt-dlp: ${pageUrl}`,
    state: 'queued',
    progress: null,
    sourceUrl: pageUrl,
    noQueue,
    mediaKind: streams === 'audio' ? 'audio' : 'video',
  };
  enqueueJob(job, {
    type: 'download_ytdlp',
    jobId,
    pageUrl,
    outDir: dir.dir,
    streams,
    filenameStem,
    maxHeight,
    cut,
  });
  return { ok: true, jobId };
}

/** Скачать обложку страницы через yt-dlp (для ютуба это превью-картинка). */
async function startThumbnailJob(pageUrl: string, pageTitle?: string): Promise<{ ok: boolean; error?: string }> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  const probed = probeCache.get(pageUrl);
  const title = (probed?.status === 'ready' ? probed.title : undefined) ?? pageTitle;
  const filenameStem = buildYtdlpStem(title, pageUrl, 'обложка', 'both');
  const job: JobInfo = {
    jobId,
    label: filenameStem,
    state: 'queued',
    progress: null,
    noQueue: true,
    mediaKind: 'image',
  };
  enqueueJob(job, { type: 'download_thumbnail', jobId, pageUrl, filenameStem, outDir: dir.dir });
  return { ok: true };
}

// ---------- Обновление Downy ----------

// GitHub API без токена — 60 запросов/час с IP, поэтому кешируем надолго
const UPDATE_CHECK_TTL_MS = 6 * 3600 * 1000;
let updateInProgress = false;

interface UpdateStatus {
  available: boolean;
  tag?: string;
  current: string;
  /** Обновление уже запущено (попап могли закрыть и открыть заново) */
  updating: boolean;
}

async function checkUpdate(): Promise<UpdateStatus> {
  const current = chrome.runtime.getManifest().version;
  const { updateCheck } = await chrome.storage.local.get('updateCheck');
  let cached = updateCheck as { at: number; tag: string } | undefined;
  if (!cached || Date.now() - cached.at >= UPDATE_CHECK_TTL_MS) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const release = (await resp.json()) as { tag_name?: string };
      cached = { at: Date.now(), tag: release.tag_name ?? '' };
    } catch {
      // Сети нет или лимит API — молчим и попробуем в следующий раз
      cached = { at: Date.now(), tag: cached?.tag ?? '' };
    }
    void chrome.storage.local.set({ updateCheck: cached });
  }
  // «Доступно» вычисляем каждый раз: после обновления та же запись кеша уже не новее
  return { available: isNewerVersion(current, cached.tag), tag: cached.tag, current, updating: updateInProgress };
}

function hasActiveJobs(): boolean {
  // Очередь тоже считается: обновление перезапустит расширение и потеряет её
  return [...jobs.values()].some((j) => j.state === 'running' || j.state === 'starting' || j.state === 'queued');
}

async function runUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (updateInProgress) return { ok: true };
  if (hasActiveJobs()) return { ok: false, error: 'Дождись окончания загрузок' };
  const status = await checkUpdate();
  if (!status.available || !status.tag) return { ok: false, error: 'Обновление не найдено' };
  const res = sendToCoApp({ type: 'update', reqId: crypto.randomUUID(), tag: status.tag });
  if (res.ok) updateInProgress = true;
  return res;
}

function broadcastUpdateProgress(state: string, message?: string): void {
  void chrome.runtime.sendMessage({ type: 'update-progress', state, message }).catch(() => {});
}

// ---------- Сообщения от попапа и content script ----------

// ---------- Прицел: медиа выбирают кликом на самой странице ----------

/**
 * Потолок качества для клика прицелом. Без разведки yt-dlp берёт «лучшее», а на
 * ютубе это 2160p: полчаса ожидания вместо пяти минут, причём чаще всего ради
 * ролика, который посмотрят один раз. Явный выбор в меню этот потолок снимает.
 */
const PICKER_MAX_HEIGHT = 1080;

/** Вкладки с включённым прицелом и счётчик взятого — для плашки на странице */
const pickCounts = new Map<number, number>();

interface PickVariant {
  label: string;
  url?: string;
  streams?: StreamSelection;
  /** Вариант уводит на другой тип: с обложки — на сам ролик */
  kind?: 'image' | 'video';
}

interface PickMessage {
  kind: 'image' | 'video';
  url?: string;
  postUrl?: string;
  variantUrl?: string;
  /** Подпись выбранного качества — уезжает в имя файла */
  variantLabel?: string;
  streams?: StreamSelection;
  /** Выбор уже сделан в меню на странице — спрашивать второй раз нечего */
  chosen?: boolean;
  pageUrl?: string;
  pageTitle?: string;
}

function tellFrames(tabId: number, msg: unknown): void {
  // Прицел живёт во всех фреймах — сообщение уходит каждому
  void chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function setPicker(tabId: number, on: boolean, why = ''): void {
  if (on) pickCounts.set(tabId, 0);
  else pickCounts.delete(tabId);
  log('bg', `прицел ${on ? 'включён' : 'выключен'}${why ? ` (${why})` : ''}, вкладка ${tabId}`);
  tellFrames(tabId, { type: 'picker', on });
}

/** Качества для меню на странице. Пусто — выбирать не из чего, качаем сразу. */
function pickVariants(item: MediaItem | undefined, pageUrl?: string): PickVariant[] {
  if (item?.variants && item.variants.length > 1) {
    const list: PickVariant[] = item.variants.map((v) => ({ label: v.label, url: v.url }));
    list.push({ label: 'Только звук', streams: 'audio' });
    return list;
  }
  // Разведка страницы уже съездила — предлагаем её форматы
  const probed = pageUrl ? probeCache.get(pageUrl) : undefined;
  if (probed?.status === 'ready') {
    const opts = qualityOptions(probed.formats);
    if (opts.length > 1) {
      const list: PickVariant[] = opts.map((q) => ({ label: q.label, url: String(q.maxHeight) }));
      list.push({ label: 'Только звук', streams: 'audio' });
      return list;
    }
  }
  return [];
}

/** Все файлы вкладки, лежащие у CDN под тем же идентификатором ассета */
function relatives(tabId: number, url: string): MediaItem[] {
  const ids = assetIds(url);
  if (ids.length === 0) return [];
  const out: MediaItem[] = [];
  for (const item of tabMedia.get(tabId)?.values() ?? []) {
    if (ids.some((id) => item.url.includes(id))) out.push(item);
  }
  // Самый весомый впереди: у превью и вес меньше, и звука нет
  return out.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
}

/** Видео этой вкладки, лежащее под тем же идентификатором, что картинка */
function relatedVideo(tabId: number, imageUrl: string): MediaItem | undefined {
  return relatives(tabId, imageUrl).find((it) => it.url !== imageUrl);
}

/**
 * Полноценный ролик вместо того, что играет в плеере. Озон (и не он один)
 * крутит на странице немое превью в низком разрешении, а файл со звуком лежит
 * рядом под тем же идентификатором — скачивать надо его.
 */
function betterVideo(tabId: number, url: string, known?: MediaItem): MediaItem | undefined {
  const best = relatives(tabId, url)[0];
  if (!best || best.url === url) return undefined;
  return (best.size ?? 0) > (known?.size ?? 0) ? best : undefined;
}

/**
 * Полная дорожка вместо превью-огрызка. В сеть попадает только то, что
 * страница проигрывала: у неоткрытого ролика есть лишь `preview.mp4` — десять
 * секунд без звука. Соседние дорожки лежат по предсказуемому адресу, поэтому
 * спрашиваем сам CDN, начиная с лучшего качества.
 */
async function fullVersionOf(url: string, pageUrl?: string): Promise<string | undefined> {
  for (const candidate of previewSiblings(url)) {
    try {
      // Диапазон в один байт: существование проверяем, файл не тянем
      const res = await fetch(candidate, {
        method: 'GET',
        headers: { Range: 'bytes=0-0', ...(pageUrl ? { Referer: pageUrl } : {}) },
      });
      if (res.ok) return candidate;
    } catch {
      // Сети нет или CDN отказал — просто пробуем следующего
    }
  }
  return undefined;
}

async function handlePick(
  tabId: number,
  msg: PickMessage,
): Promise<{ ok: boolean; error?: string; variants?: PickVariant[] }> {
  const streams = msg.streams ?? 'both';
  const picked = msg.chosen === true || msg.variantUrl != null || msg.streams != null;

  if (msg.kind === 'image') {
    if (!msg.url) return { ok: false, error: 'У картинки нет адреса' };
    // Обложка ролика лежит у CDN по соседству с самим роликом под общим
    // идентификатором. Нашли пару — спрашиваем, что человеку нужно
    if (!picked) {
      const video = relatedVideo(tabId, msg.url);
      if (video) {
        return {
          ok: true,
          variants: [
            { label: 'Скачать ролик', kind: 'video', url: video.url },
            { label: 'Скачать картинку', kind: 'image', url: msg.url },
          ],
        };
      }
    }
    log('page', `взяли картинку ${msg.url.slice(0, 160)}`);
    const item: MediaItem = {
      url: msg.url,
      kind: 'direct',
      tabId,
      foundAt: Date.now(),
      contentType: 'image/jpeg',
      pageUrl: msg.pageUrl,
      pageTitle: imageStem(msg.url, msg.pageTitle),
    };
    const res = await startDirectJob(item, 'both');
    if (res.ok && res.jobId) trackPageJob(tabId, res.jobId);
    return res;
  }

  // Видео с прямым адресом: он уже пойман по сети, оттуда варианты и размер
  if (msg.url) {
    const known = tabMedia.get(tabId)?.get(msg.url);
    if (!picked) {
      const variants = pickVariants(known);
      if (variants.length) return { ok: true, variants };
    }
    // Плеер мог играть немое превью — берём полный файл того же ролика
    const better = picked ? undefined : betterVideo(tabId, msg.url, known);
    if (better) {
      log('page', `вместо превью качаем полный файл: ${better.url.slice(0, 160)}`);
    }
    // Полного файла в сети могло не быть вовсе: ролик не проигрывали, и есть
    // только превью. Спрашиваем CDN про соседей — там ролик целиком и со звуком
    let url = better?.url ?? msg.url;
    if (!better) {
      const full = await fullVersionOf(url, msg.pageUrl);
      if (full) {
        log('page', `превью подменили полной дорожкой: ${full.slice(0, 160)}`);
        url = full;
      }
    }
    const item: MediaItem = better ?? (url === msg.url ? known : undefined) ?? {
      url,
      kind: 'direct',
      tabId,
      foundAt: Date.now(),
      pageUrl: msg.pageUrl,
      pageTitle: msg.pageTitle,
    };
    log('page', `взяли видео ${item.kind} streams=${streams} ${msg.url.slice(0, 160)}`);
    const res =
      item.kind === 'direct'
        ? await startDirectJob(item, streams)
        : await startHlsJob(item, msg.variantUrl, msg.variantLabel, streams);
    if (res.ok && res.jobId) trackPageJob(tabId, res.jobId);
    return res;
  }

  // MSE: потока с адресом нет, качаем страницу поста через yt-dlp
  const pageUrl = msg.postUrl ?? msg.pageUrl;
  if (!pageUrl) return { ok: false, error: 'Не удалось понять, что это за видео' };
  if (!picked) {
    const variants = pickVariants(undefined, pageUrl);
    if (variants.length) return { ok: true, variants };
  }
  log(
    'page',
    `взяли видео через yt-dlp streams=${streams} до ${msg.variantUrl ?? PICKER_MAX_HEIGHT}p ${pageUrl.slice(0, 160)}`,
  );
  // У yt-dlp вариант приходит высотой кадра, а не адресом
  const maxHeight = msg.variantUrl ? Number(msg.variantUrl) : PICKER_MAX_HEIGHT;
  // В имя файла идёт «1080p60» — без веса, который висит в подписи меню
  const qualityLabel = msg.variantLabel?.split(' · ')[0];
  // Заголовок вкладки годится, только когда качаем её же. Из ленты уходит
  // адрес чужого ролика, и «(9) YouTube» стало бы именем всем подряд —
  // пусть yt-dlp сам подставит настоящее название
  const title = pageUrl === msg.pageUrl ? msg.pageTitle : undefined;
  const res = await startYtdlpJob(pageUrl, title, streams, maxHeight, qualityLabel);
  if (res.ok && res.jobId) trackPageJob(tabId, res.jobId);
  return res;
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-picker') return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) setPicker(tab.id, !pickCounts.has(tab.id), 'хоткей');
  })();
});

/** Запасной путь к прицелу: там, где правый клик сайтом не перехвачен.
 *  Пересобираем при каждом пробуждении воркера — иначе пункты живут только
 *  до первой выгрузки service worker и «пропадают» без всякой причины. */
function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const quiet = (): void => void chrome.runtime.lastError;
    chrome.contextMenus.create(
      { id: 'downy-image', title: 'Скачать картинку через Downy', contexts: ['image'] },
      quiet,
    );
    chrome.contextMenus.create(
      { id: 'downy-media', title: 'Скачать это видео через Downy', contexts: ['video', 'audio'] },
      quiet,
    );
    chrome.contextMenus.create(
      { id: 'downy-page', title: 'Скачать видео с этой страницы (yt-dlp)', contexts: ['page'] },
      quiet,
    );
  });
}

setupContextMenus();
chrome.runtime.onInstalled.addListener(setupContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (tabId == null || !tab) return;
  const common = { pageUrl: info.pageUrl, pageTitle: tab.title };

  if (info.menuItemId === 'downy-image' && info.srcUrl) {
    void handlePick(tabId, { kind: 'image', url: info.srcUrl, ...common });
    return;
  }
  if (info.menuItemId === 'downy-media') {
    // У MSE-плеера srcUrl это blob: — качать по нему нечего, идём через yt-dlp
    const direct = info.srcUrl && !info.srcUrl.startsWith('blob:') ? info.srcUrl : undefined;
    void handlePick(tabId, { kind: 'video', url: direct, postUrl: direct ? undefined : info.pageUrl, ...common });
    return;
  }
  if (info.menuItemId === 'downy-page') {
    void handlePick(tabId, { kind: 'video', postUrl: info.pageUrl, ...common });
  }
});

interface Message {
  type: string;
  [key: string]: unknown;
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  void (async () => {
    await restored;
    switch (msg.type) {
      case 'dom-media': {
        const tabId = sender.tab?.id;
        if (tabId == null || tabId < 0) break;
        const pageTitle = msg.pageTitle as string | undefined;
        const pageThumb = msg.pageThumb as string | undefined;
        if (pageThumb) {
          tabPageThumb.set(tabId, pageThumb);
          persist();
        }
        const mse = msg.mseVideo as { url?: string; thumb?: string } | undefined;
        const pageUrl = msg.pageUrl as string | undefined;
        if (mse && pageUrl) {
          // В ленте (x.com/home) качаем не страницу, а конкретный пост.
          // Хэш срезаем: плееры пишут туда позицию/серию и меняют на лету —
          // без среза одно видео плодит карточку на каждый чих хэша
          const videoUrl = mse.url ?? stripHash(pageUrl);
          if (!tabRemoved.get(tabId)?.has(videoUrl)) {
            const vids = tabPageVideos.get(tabId) ?? new Map<string, PageVideo>();
            const existing = vids.get(videoUrl);
            if (existing) {
              // Дозрели данные — дольём, позицию в списке не трогаем
              if (mse.thumb && !existing.thumb) existing.thumb = mse.thumb;
              if (pageTitle && !existing.title) existing.title = pageTitle;
            } else {
              vids.set(videoUrl, { url: videoUrl, pageHref: pageUrl, title: pageTitle, thumb: mse.thumb });
              // Ленту можно листать бесконечно — старьё выпихиваем
              while (vids.size > PAGE_VIDEOS_MAX) vids.delete(vids.keys().next().value!);
            }
            tabPageVideos.set(tabId, vids);
            persist();
          }
        }
        for (const entry of (msg.media ?? []) as { url: string; thumb?: string }[]) {
          const kind = classifyMedia(entry.url);
          if (kind === 'hls') void addHls(tabId, entry.url, pageTitle, entry.thumb);
          else if (kind === 'dash') void addDash(tabId, entry.url, pageTitle, entry.thumb);
          else if (kind === 'direct') void addDirect(tabId, canonicalMediaUrl(entry.url), undefined, undefined, pageTitle, entry.thumb);
          else if (entry.thumb) {
            // Медиа уже могло быть найдено по сети — хотя бы дольём превью
            const existing = getTabItems(tabId).get(canonicalMediaUrl(entry.url));
            if (existing && !existing.thumb) {
              existing.thumb = entry.thumb;
              persist();
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case 'get-media': {
        const tabId = msg.tabId as number;
        const items = [...(tabMedia.get(tabId)?.values() ?? [])].sort((a, b) => a.foundAt - b.foundAt);
        for (const item of items) requestThumb(item);
        // Видео-посты вкладки — сразу заряжаем разведку качеств каждому
        const pageVideos = [...(tabPageVideos.get(tabId)?.values() ?? [])].map((v) => ({
          ...v,
          probe: ensureProbe(v.url),
        }));
        // Заодно оживляем очередь, если она встала (например, CoApp падал)
        pump();
        sendResponse({
          items,
          jobs: jobList(),
          pageThumb: tabPageThumb.get(tabId),
          pageVideos,
        });
        break;
      }
      case 'remove-media': {
        // Крестик на карточке: прячем находку и не даём ей вернуться
        const tabId = msg.tabId as number;
        const removed = tabRemoved.get(tabId) ?? new Set<string>();
        for (const url of (msg.urls as string[]) ?? []) {
          removed.add(url);
          tabMedia.get(tabId)?.delete(url);
          tabPageVideos.get(tabId)?.delete(url);
        }
        tabRemoved.set(tabId, removed);
        persist();
        sendResponse({ ok: true });
        break;
      }
      case 'pick': {
        const tabId = sender.tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: 'Не понял, с какой вкладки' });
          break;
        }
        sendResponse(await handlePick(tabId, msg as unknown as PickMessage));
        break;
      }
      case 'picker-off': {
        const tabId = sender.tab?.id;
        if (tabId != null) setPicker(tabId, false, 'со страницы');
        sendResponse({ ok: true });
        break;
      }
      case 'toggle-picker': {
        const tabId = msg.tabId as number | undefined;
        if (tabId != null) setPicker(tabId, !pickCounts.has(tabId), 'из попапа');
        sendResponse({ ok: true });
        break;
      }
      case 'log': {
        // Метку шлёт отправитель: попап и прицел на странице различаются
        log(msg.source === 'page' ? 'page' : 'popup', String(msg.message ?? ''));
        sendResponse({ ok: true });
        break;
      }
      case 'download-direct': {
        sendResponse(await startDirectJob(
          msg.item as MediaItem,
          msg.streams as StreamSelection | undefined,
          msg.cut as CutRange | undefined,
        ));
        break;
      }
      case 'download-hls': {
        const res = await startHlsJob(
          msg.item as MediaItem,
          msg.variantUrl as string | undefined,
          msg.variantLabel as string | undefined,
          msg.streams as StreamSelection | undefined,
          msg.cut as CutRange | undefined,
        );
        sendResponse(res);
        break;
      }
      case 'download-ytdlp': {
        const res = await startYtdlpJob(
          msg.pageUrl as string,
          msg.pageTitle as string | undefined,
          msg.streams as StreamSelection | undefined,
          msg.maxHeight as number | undefined,
          msg.qualityLabel as string | undefined,
          msg.cut as CutRange | undefined,
        );
        sendResponse(res);
        break;
      }
      case 'download-thumb-ytdlp': {
        sendResponse(await startThumbnailJob(msg.pageUrl as string, msg.pageTitle as string | undefined));
        break;
      }
      case 'cancel-job': {
        const id = msg.jobId as string;
        const job = jobs.get(id);
        if (job && (job.state === 'queued' || job.state === 'paused')) {
          // До хоста эта загрузка не дошла или уже убита — гасим локально
          job.state = 'canceled';
          jobRequests.delete(id);
          if (job.outFile) sendToCoApp({ type: 'cleanup_partials', path: job.outFile });
          job.outFile = undefined;
          persist();
          broadcastJobs();
          pump();
          sendResponse({ ok: true });
        } else {
          sendResponse(sendToCoApp({ type: 'cancel', jobId: id }));
        }
        break;
      }
      case 'pause-job': {
        const job = jobs.get(msg.jobId as string);
        if (!job) {
          sendResponse({ ok: false, error: 'Загрузка не найдена' });
        } else if (job.state === 'running' || job.state === 'starting') {
          job.pausedBy = 'user';
          sendResponse(sendToCoApp({ type: 'pause', jobId: job.jobId }));
        } else if (job.state === 'queued') {
          job.state = 'paused';
          job.pausedBy = 'user';
          persist();
          broadcastJobs();
          pump();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: true });
        }
        break;
      }
      case 'resume-job': {
        const job = jobs.get(msg.jobId as string);
        if (job && job.state === 'paused') {
          job.state = 'queued';
          job.pausedBy = undefined;
          persist();
          broadcastJobs();
          pump();
        }
        sendResponse({ ok: true });
        break;
      }
      case 'reorder-jobs': {
        const { order, preemptId } = applyReorder(queueOrder, (msg.order as string[]) ?? [], jobs);
        queueOrder = order;
        if (preemptId) {
          // Наверх приехала другая — активную на паузу; её paused-событие
          // запустит pump, и новая голова стартует
          const active = jobs.get(preemptId);
          if (active) active.pausedBy = 'preempt';
          sendToCoApp({ type: 'pause', jobId: preemptId });
        } else {
          pump();
        }
        persist();
        broadcastJobs();
        sendResponse({ ok: true });
        break;
      }
      case 'show-in-folder': {
        sendResponse(sendToCoApp({ type: 'show_in_folder', path: msg.path as string }));
        break;
      }
      case 'open-file': {
        sendResponse(sendToCoApp({ type: 'open_file', path: msg.path as string }));
        break;
      }
      case 'remove-job': {
        // Убрать одну завершённую строку; активную так не трогаем — у неё отмена
        const id = msg.jobId as string;
        const job = jobs.get(id);
        if (job && !isUnfinished(job.state)) {
          log('bg', `убрали из списка ${id} ${job.label}`);
          jobs.delete(id);
          jobRequests.delete(id);
          persist();
        }
        sendResponse({ jobs: jobList() });
        break;
      }
      case 'clear-jobs': {
        for (const [id, job] of jobs) {
          if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') {
            jobs.delete(id);
            jobRequests.delete(id);
          }
        }
        persist();
        sendResponse({ jobs: jobList() });
        break;
      }
      case 'coapp-status': {
        sendResponse(await pingCoApp());
        break;
      }
      case 'check-update': {
        sendResponse(await checkUpdate());
        break;
      }
      case 'run-update': {
        sendResponse(await runUpdate());
        break;
      }
      case 'pick-out-dir': {
        const res = await pickDirDialog(msg.current as string | undefined);
        // Сохраняем в фоне: выбор не потеряется, даже если попап уже закрыт
        if (res.dir) await chrome.storage.local.set({ outDir: res.dir });
        sendResponse(res.error ? { ok: false, error: res.error } : { ok: true, dir: res.dir });
        break;
      }
      default:
        sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
    }
  })();
  return true; // ответ асинхронный
});
