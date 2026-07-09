import { classifyMedia, isProbablyVideo } from './lib/media-detect';
import { canonicalMediaUrl } from './lib/media-group';
import { isMasterPlaylist, looksLikePlaylist, parseMasterPlaylist, playlistDuration } from './lib/m3u8';
import { looksLikeMpd, mpdDuration } from './lib/mpd';
import { buildFilename } from './lib/filename';
import { isNewerVersion, REPO } from './lib/update';
import type { JobInfo, MediaItem } from './lib/types';
import type { CoAppEvent, CoAppRequest, PongEvent, StreamSelection } from '../../shared/protocol';

const NATIVE_HOST = 'com.downy.coapp';

// ---------- Состояние ----------

const tabMedia = new Map<number, Map<string, MediaItem>>();
// URL дочерних плейлистов известных мастеров — их не показываем отдельно
const tabVariantUrls = new Map<number, Set<string>>();
// Обложка страницы (og:image) — превью-фолбэк для медиа, найденного по сети
const tabPageThumb = new Map<number, string>();
const jobs = new Map<string, JobInfo>();
const inflightHls = new Set<string>();

// Service worker может быть выгружен в любой момент — состояние живёт в storage.session
const restored: Promise<void> = (async () => {
  const data = await chrome.storage.session.get(['tabMedia', 'jobs', 'tabVariantUrls', 'tabPageThumb']);
  if (data.tabPageThumb) {
    for (const [tabId, thumb] of Object.entries(data.tabPageThumb as Record<string, string>)) {
      tabPageThumb.set(Number(tabId), thumb);
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
  if (data.jobs) {
    for (const [id, job] of Object.entries(data.jobs as Record<string, JobInfo>)) {
      // Рестарт SW закрыл порт, CoApp вместе с загрузками умер —
      // иначе job навсегда останется «running» в попапе
      if (job.state === 'running' || job.state === 'starting') {
        job.state = 'error';
        job.message = 'Прервано перезапуском браузера';
      }
      jobs.set(id, job);
    }
  }
})();

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
      jobs: Object.fromEntries(jobs),
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
    job.progress = msg.progress;
    job.message = msg.message;
    if (msg.bytes != null) job.bytes = msg.bytes;
    if (msg.totalBytes != null) job.totalBytes = msg.totalBytes;
    if (msg.outFile) job.outFile = msg.outFile;
    persist();
    broadcastJobs();
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
    // Дадим шанс перезапросить кадры при следующем открытии попапа
    for (const { url } of pendingThumbs.values()) thumbTried.delete(url);
    pendingThumbs.clear();
    for (const job of jobs.values()) {
      if (job.state === 'running' || job.state === 'starting') {
        job.state = 'error';
        job.message = err ?? 'CoApp отключился';
      }
    }
    persist();
    broadcastJobs();
  });
  coappPort = port;
  return port;
}

function broadcastJobs(): void {
  void chrome.runtime.sendMessage({ type: 'jobs-updated', jobs: [...jobs.values()] }).catch(() => {});
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

function pingCoApp(): Promise<{ ok: boolean; info?: PongEvent; error?: string }> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      port.disconnect();
      resolve({ ok: false, error: 'CoApp не ответил за 3 секунды' });
    }, 3000);
    port.onMessage.addListener((msg: CoAppEvent) => {
      if (msg.type === 'pong') {
        clearTimeout(timer);
        port.disconnect();
        resolve({ ok: true, info: msg });
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'CoApp не установлен' });
    });
    port.postMessage({ type: 'ping' } satisfies CoAppRequest);
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

async function getOutDir(): Promise<string | undefined> {
  const { outDir } = await chrome.storage.local.get({ outDir: '' });
  return (outDir as string).trim() || undefined;
}

async function startHlsJob(
  item: MediaItem,
  variantUrl?: string,
  variantLabel?: string,
  streams: StreamSelection = 'both',
): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item, variantLabel, streams);
  const job: JobInfo = { jobId, label: filename, state: 'starting', progress: null, sourceUrl: item.url };
  jobs.set(jobId, job);
  const res = sendToCoApp({
    type: 'download_hls',
    jobId,
    url: variantUrl ?? item.url,
    filename,
    outDir: await getOutDir(),
    streams,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  if (!res.ok) {
    job.state = 'error';
    job.message = res.error;
  }
  persist();
  broadcastJobs();
  return res;
}

async function startDirectJob(item: MediaItem, streams: StreamSelection = 'both'): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item, undefined, streams);
  const job: JobInfo = { jobId, label: filename, state: 'starting', progress: null, totalBytes: streams === 'both' ? item.size : undefined, sourceUrl: item.url };
  jobs.set(jobId, job);
  const res = sendToCoApp({
    type: 'download_direct',
    jobId,
    url: item.url,
    filename,
    outDir: await getOutDir(),
    streams,
    headers: { referer: item.pageUrl, userAgent: navigator.userAgent },
  });
  if (!res.ok) {
    job.state = 'error';
    job.message = res.error;
  }
  persist();
  broadcastJobs();
  return res;
}

async function startYtdlpJob(
  pageUrl: string,
  pageTitle?: string,
  streams: StreamSelection = 'both',
): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const job: JobInfo = {
    jobId,
    label: `yt-dlp: ${pageTitle?.trim() || pageUrl}`,
    state: 'starting',
    progress: null,
    sourceUrl: pageUrl,
  };
  jobs.set(jobId, job);
  const res = sendToCoApp({ type: 'download_ytdlp', jobId, pageUrl, outDir: await getOutDir(), streams });
  if (!res.ok) {
    job.state = 'error';
    job.message = res.error;
  }
  persist();
  broadcastJobs();
  return res;
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
  return [...jobs.values()].some((j) => j.state === 'running' || j.state === 'starting');
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
        sendResponse({ items, jobs: [...jobs.values()], pageThumb: tabPageThumb.get(tabId) });
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
        );
        sendResponse(res);
        break;
      }
      case 'cancel-job': {
        sendResponse(sendToCoApp({ type: 'cancel', jobId: msg.jobId as string }));
        break;
      }
      case 'show-in-folder': {
        sendResponse(sendToCoApp({ type: 'show_in_folder', path: msg.path as string }));
        break;
      }
      case 'clear-jobs': {
        for (const [id, job] of jobs) {
          if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') jobs.delete(id);
        }
        persist();
        sendResponse({ jobs: [...jobs.values()] });
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
        const reqId = crypto.randomUUID();
        const res = await new Promise<{ dir: string | null; error?: string }>((resolve) => {
          pendingPickDir.set(reqId, resolve);
          const sent = sendToCoApp({ type: 'pick_dir', reqId, current: msg.current as string | undefined });
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
