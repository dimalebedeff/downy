import { classifyMedia, isProbablyVideo } from './lib/media-detect';
import { isMasterPlaylist, looksLikePlaylist, parseMasterPlaylist, playlistDuration } from './lib/m3u8';
import { buildFilename } from './lib/filename';
import type { JobInfo, MediaItem } from './lib/types';
import type { CoAppEvent, CoAppRequest, PongEvent } from '../../shared/protocol';

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

function updateBadge(tabId: number): void {
  const n = tabMedia.get(tabId)?.size ?? 0;
  void chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
}

function clearTab(tabId: number): void {
  tabMedia.delete(tabId);
  tabVariantUrls.delete(tabId);
  tabPageThumb.delete(tabId);
  updateBadge(tabId);
  persist();
}

void chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });

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
  updateBadge(item.tabId);
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
    let size: number | undefined;
    if (details.statusCode === 206) {
      const m = header('content-range')?.match(/\/(\d+)\s*$/);
      if (m) size = parseInt(m[1], 10);
    } else {
      const cl = header('content-length');
      if (cl) size = parseInt(cl, 10);
    }
    void addDirect(details.tabId, details.url, contentType ?? undefined, size);
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
  if (item.kind !== 'hls' && !isProbablyVideo(item.url, item.contentType)) return;
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

async function startHlsJob(item: MediaItem, variantUrl?: string, variantLabel?: string): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item, variantLabel);
  const job: JobInfo = { jobId, label: filename, state: 'starting', progress: null };
  jobs.set(jobId, job);
  const res = sendToCoApp({
    type: 'download_hls',
    jobId,
    url: variantUrl ?? item.url,
    filename,
    outDir: await getOutDir(),
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

async function startDirectJob(item: MediaItem): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const filename = buildFilename(item);
  const job: JobInfo = { jobId, label: filename, state: 'starting', progress: null, totalBytes: item.size };
  jobs.set(jobId, job);
  const res = sendToCoApp({
    type: 'download_direct',
    jobId,
    url: item.url,
    filename,
    outDir: await getOutDir(),
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

async function startYtdlpJob(pageUrl: string, pageTitle?: string): Promise<{ ok: boolean; error?: string }> {
  const jobId = crypto.randomUUID();
  const job: JobInfo = {
    jobId,
    label: `yt-dlp: ${pageTitle?.trim() || pageUrl}`,
    state: 'starting',
    progress: null,
  };
  jobs.set(jobId, job);
  const res = sendToCoApp({ type: 'download_ytdlp', jobId, pageUrl, outDir: await getOutDir() });
  if (!res.ok) {
    job.state = 'error';
    job.message = res.error;
  }
  persist();
  broadcastJobs();
  return res;
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
          else if (kind === 'direct') void addDirect(tabId, entry.url, undefined, undefined, pageTitle, entry.thumb);
          else if (entry.thumb) {
            // Медиа уже могло быть найдено по сети — хотя бы дольём превью
            const existing = getTabItems(tabId).get(entry.url);
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
        sendResponse(await startDirectJob(msg.item as MediaItem));
        break;
      }
      case 'download-hls': {
        const res = await startHlsJob(
          msg.item as MediaItem,
          msg.variantUrl as string | undefined,
          msg.variantLabel as string | undefined,
        );
        sendResponse(res);
        break;
      }
      case 'download-ytdlp': {
        const res = await startYtdlpJob(msg.pageUrl as string, msg.pageTitle as string | undefined);
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
