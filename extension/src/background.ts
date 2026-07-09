import { classifyMedia, isProbablyVideo } from './lib/media-detect';
import { canonicalMediaUrl } from './lib/media-group';
import { isMasterPlaylist, looksLikePlaylist, parseMasterPlaylist, playlistDuration } from './lib/m3u8';
import { looksLikeMpd, mpdDuration } from './lib/mpd';
import { buildFilename, buildYtdlpStem } from './lib/filename';
import { isNewerVersion, REPO } from './lib/update';
import { applyReorder, isUnfinished, nextToStart, normalizeOrder } from './lib/queue';
import type { JobInfo, MediaItem, ProbeState } from './lib/types';
import type {
  CoAppEvent,
  CoAppRequest,
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
  url: string;
  title?: string;
  thumb?: string;
}
const tabPageVideo = new Map<number, PageVideo>();
const jobs = new Map<string, JobInfo>();
const inflightHls = new Set<string>();

// ---------- Очередь: качается одна, остальные ждут ----------

/** Порядок незавершённых загрузок; голова — активная */
let queueOrder: string[] = [];
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
    'tabMedia', 'jobs', 'tabVariantUrls', 'tabPageThumb', 'tabPageVideo', 'queueOrder', 'jobRequests',
  ]);
  if (data.tabPageThumb) {
    for (const [tabId, thumb] of Object.entries(data.tabPageThumb as Record<string, string>)) {
      tabPageThumb.set(Number(tabId), thumb);
    }
  }
  if (data.tabPageVideo) {
    for (const [tabId, pv] of Object.entries(data.tabPageVideo as Record<string, PageVideo>)) {
      tabPageVideo.set(Number(tabId), pv);
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
    void chrome.storage.session.set({
      tabMedia: tm,
      tabVariantUrls: tv,
      tabPageThumb: Object.fromEntries(tabPageThumb),
      tabPageVideo: Object.fromEntries(tabPageVideo),
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
  tabPageVideo.delete(tabId);
  persist();
}

// ---------- Детекция ----------

async function pageInfo(tabId: number): Promise<{ pageUrl?: string; pageTitle?: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { pageUrl: tab?.url, pageTitle: tab?.title };
}

function upsertItem(item: MediaItem): void {
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
    job.state = msg.state;
    // Пауза шлёт progress: null — не стираем позицию полоски
    if (msg.state !== 'paused' || msg.progress != null) job.progress = msg.progress;
    job.message = msg.message;
    if (msg.bytes != null) job.bytes = msg.bytes;
    if (msg.totalBytes != null) job.totalBytes = msg.totalBytes;
    if (msg.outFile) job.outFile = msg.outFile;
    if (msg.state === 'done' || msg.state === 'error' || msg.state === 'canceled') {
      jobRequests.delete(msg.jobId);
    }
    persist();
    broadcastJobs();
    // Место освободилось (готово/ошибка/отмена/пауза) — очередь едет дальше
    if (msg.state !== 'running') pump();
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
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

function broadcastJobs(): void {
  void chrome.runtime.sendMessage({ type: 'jobs-updated', jobs: jobList() }).catch(() => {});
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
    const timer = setTimeout(() => done({ ok: false, error: 'CoApp не ответил за 3 секунды' }), 3000);
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

async function startHlsJob(
  item: MediaItem,
  variantUrl?: string,
  variantLabel?: string,
  streams: StreamSelection = 'both',
): Promise<{ ok: boolean; error?: string }> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item, variantLabel, streams);
  const job: JobInfo = { jobId, label: filename, state: 'queued', progress: null, sourceUrl: item.url };
  enqueueJob(job, {
    type: 'download_hls',
    jobId,
    url: variantUrl ?? item.url,
    filename,
    outDir: dir.dir,
    streams,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  return { ok: true };
}

async function startDirectJob(item: MediaItem, streams: StreamSelection = 'both'): Promise<{ ok: boolean; error?: string }> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item, undefined, streams);
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
    totalBytes: streams === 'both' ? item.size : undefined,
    sourceUrl: item.url,
    noQueue,
  };
  enqueueJob(job, {
    type: 'download_direct',
    jobId,
    url: item.url,
    filename,
    outDir: dir.dir,
    streams,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  return { ok: true };
}

async function startYtdlpJob(
  pageUrl: string,
  pageTitle?: string,
  streams: StreamSelection = 'both',
  maxHeight?: number,
  qualityLabel?: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = await resolveJobOutDir();
  if (dir.canceled) return { ok: true };
  if (dir.error) return { ok: false, error: dir.error };
  const jobId = crypto.randomUUID();
  // Название знаем из разведки — имя собираем сами (с датой и страховкой
  // от перезаписи на хосте); разведки нет — yt-dlp именует по шаблону
  const probed = probeCache.get(pageUrl);
  const ready = probed?.status === 'ready' ? probed : undefined;
  const title = ready?.title ?? pageTitle;
  const filenameStem = title ? buildYtdlpStem(title, pageUrl, qualityLabel, streams) : undefined;
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
  };
  enqueueJob(job, {
    type: 'download_ytdlp',
    jobId,
    pageUrl,
    outDir: dir.dir,
    streams,
    filenameStem,
    maxHeight,
  });
  return { ok: true };
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
  const job: JobInfo = { jobId, label: filenameStem, state: 'queued', progress: null, noQueue: true };
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
        const mse = msg.mseVideo as { thumb?: string } | undefined;
        const pageUrl = msg.pageUrl as string | undefined;
        if (mse && pageUrl) {
          // Наследуем title/thumb только той же страницы: SPA мог сменить ролик
          const prev = tabPageVideo.get(tabId);
          const samePage = prev?.url === pageUrl;
          tabPageVideo.set(tabId, {
            url: pageUrl,
            title: pageTitle ?? (samePage ? prev?.title : undefined),
            thumb: mse.thumb ?? (samePage ? prev?.thumb : undefined),
          });
          persist();
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
        // Страница с MSE-видео — сразу заряжаем разведку качеств
        const pageVideo = tabPageVideo.get(tabId);
        // Заодно оживляем очередь, если она встала (например, CoApp падал)
        pump();
        sendResponse({
          items,
          jobs: jobList(),
          pageThumb: tabPageThumb.get(tabId),
          pageVideo,
          probe: pageVideo ? ensureProbe(pageVideo.url) : undefined,
        });
        break;
      }
      case 'download-direct': {
        sendResponse(await startDirectJob(msg.item as MediaItem, msg.streams as StreamSelection | undefined));
        break;
      }
      case 'download-hls': {
        const res = await startHlsJob(
          msg.item as MediaItem,
          msg.variantUrl as string | undefined,
          msg.variantLabel as string | undefined,
          msg.streams as StreamSelection | undefined,
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
