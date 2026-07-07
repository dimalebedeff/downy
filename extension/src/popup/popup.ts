import type { JobInfo, MediaItem } from '../lib/types';
import type { StreamSelection } from '../../../shared/protocol';
import { fmtSize, jobProgressView } from '../lib/progress';
import { groupMediaItems } from '../lib/media-group';
import { isProbablyVideo } from '../lib/media-detect';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const mediaList = $<HTMLUListElement>('#media-list');
const emptyEl = $<HTMLDivElement>('#empty');
const jobsSection = $<HTMLElement>('#jobs-section');
const jobsList = $<HTMLUListElement>('#jobs-list');
const coappStatusEl = $<HTMLSpanElement>('#coapp-status');
const outDirInput = $<HTMLInputElement>('#out-dir');

let activeTab: chrome.tabs.Tab | undefined;
let pageThumb: string | undefined;

function fmtDuration(sec?: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Селектор «что качать»: видео+звук / только видео / только звук */
function streamsSelect(): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'streams';
  select.title = 'Какие дорожки сохранить';
  for (const [value, label] of [['both', 'видео+звук'], ['video', 'видео'], ['audio', 'звук']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  }
  return select;
}

function itemTitle(item: MediaItem): string {
  if (item.pageTitle?.trim()) return item.pageTitle.trim();
  try {
    return decodeURIComponent(new URL(item.url).pathname.split('/').pop() || item.url);
  } catch {
    return item.url;
  }
}

function renderMedia(items: MediaItem[]): void {
  mediaList.textContent = '';
  const groups = groupMediaItems(items);
  emptyEl.hidden = groups.length > 0;
  for (const group of groups) {
    const item = group.primary;
    const li = document.createElement('li');
    li.className = 'item';

    const thumbSrc = item.thumb ?? pageThumb;
    const thumbBox = document.createElement('div');
    thumbBox.className = 'thumb';
    if (thumbSrc) {
      const img = document.createElement('img');
      img.src = thumbSrc;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      thumbBox.append(img);
    } else {
      thumbBox.textContent = item.kind === 'hls' || item.contentType?.startsWith('video') ? '🎬' : '🎵';
    }

    const body = document.createElement('div');
    body.className = 'item-body';

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item.kind === 'hls' ? 'HLS' : (item.contentType?.split('/')[1] ?? 'файл').toUpperCase().slice(0, 5);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = itemTitle(item);
    title.title = item.url;
    row1.append(chip, title);

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const parts: string[] = [];
    if (item.size) parts.push(fmtSize(item.size));
    if (item.durationSec) parts.push(fmtDuration(item.durationSec));
    if (item.kind === 'hls' && item.variants?.length) parts.push(`${item.variants.length} кач.`);
    if (item.contentType) parts.push(item.contentType.split(';')[0]);
    meta.textContent = parts.join(' · ');
    row2.append(meta);

    let select: HTMLSelectElement | null = null;
    if (item.kind === 'hls' && item.variants && item.variants.length > 0) {
      select = document.createElement('select');
      for (const v of item.variants) {
        const opt = document.createElement('option');
        opt.value = v.url;
        opt.textContent = v.label;
        select.append(opt);
      }
      row2.append(select);
    } else if (item.kind === 'direct' && group.members.length > 1) {
      // Варианты одного видео (разные качества) — один пункт с выбором
      select = document.createElement('select');
      for (const [i, m] of group.members.entries()) {
        const opt = document.createElement('option');
        opt.value = m.url;
        opt.textContent = fmtSize(m.size) || m.contentType?.split('/')[1] || `вариант ${i + 1}`;
        select.append(opt);
      }
      row2.append(select);
    }

    // Для видео можно выбрать, какие дорожки сохранять
    let streams: HTMLSelectElement | null = null;
    if (item.kind === 'hls' || isProbablyVideo(item.url, item.contentType)) {
      streams = streamsSelect();
      row2.append(streams);
    }

    const btn = document.createElement('button');
    btn.textContent = 'Скачать';
    btn.addEventListener('click', () => {
      const chosen =
        item.kind === 'direct' && select
          ? group.members.find((m) => m.url === select!.value) ?? item
          : item;
      void download(chosen, item.kind === 'hls' ? select : null, (streams?.value as StreamSelection) ?? 'both', btn);
    });
    row2.append(btn);

    body.append(row1, row2);
    li.append(thumbBox, body);
    mediaList.append(li);
  }
}

async function download(
  item: MediaItem,
  select: HTMLSelectElement | null,
  streams: StreamSelection,
  btn: HTMLButtonElement,
): Promise<void> {
  btn.disabled = true;
  try {
    if (item.kind === 'direct') {
      const res = await chrome.runtime.sendMessage({ type: 'download-direct', item, streams });
      if (!res?.ok) showError(res?.error ?? 'Не удалось начать скачивание');
    } else {
      const variantUrl = select?.value;
      const variantLabel = select?.selectedOptions[0]?.textContent ?? undefined;
      const res = await chrome.runtime.sendMessage({ type: 'download-hls', item, variantUrl, variantLabel, streams });
      if (!res?.ok) showError(res?.error ?? 'CoApp недоступен');
    }
  } finally {
    setTimeout(() => (btn.disabled = false), 1000);
  }
}

// ---------- Обновление Downy ----------

const updateBtn = $<HTMLButtonElement>('#update-btn');
let hasActiveJobs = false;
let updating = false;

function syncUpdateBtn(): void {
  if (updateBtn.hidden || updating) return;
  updateBtn.disabled = hasActiveJobs;
  updateBtn.title = hasActiveJobs ? 'Дождись окончания загрузок' : '';
}

async function initUpdater(): Promise<void> {
  $<HTMLDivElement>('#version').textContent = `Downy v${chrome.runtime.getManifest().version}`;
  const status = await chrome.runtime.sendMessage({ type: 'check-update' });
  if (!status?.available) return;
  updateBtn.hidden = false;
  updateBtn.textContent = `Обновить Downy до ${status.tag}`;
  syncUpdateBtn();
  updateBtn.addEventListener('click', async () => {
    updating = true;
    updateBtn.disabled = true;
    updateBtn.textContent = 'Скачиваю…';
    const res = await chrome.runtime.sendMessage({ type: 'run-update' });
    if (!res?.ok) onUpdateProgress('error', res?.error);
  });
}

function onUpdateProgress(state: string, message?: string): void {
  switch (state) {
    case 'downloading':
      updateBtn.textContent = 'Скачиваю…';
      break;
    case 'installing':
      updateBtn.textContent = 'Устанавливаю…';
      break;
    case 'done':
      updateBtn.textContent = 'Готово, перезапускаюсь…';
      break;
    case 'error': {
      updating = false;
      updateBtn.disabled = false;
      updateBtn.textContent = 'Обновление не удалось — повторить';
      updateBtn.title = message ?? '';
      showError(message ?? 'Обновление не удалось');
      break;
    }
  }
}

function renderJobs(jobs: JobInfo[]): void {
  hasActiveJobs = jobs.some((j) => j.state === 'running' || j.state === 'starting');
  syncUpdateBtn();
  jobsSection.hidden = jobs.length === 0;
  jobsList.textContent = '';
  for (const job of jobs) {
    const li = document.createElement('li');
    li.className = 'job';

    const row = document.createElement('div');
    row.className = 'row1';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = job.label;
    title.title = job.outFile ?? job.label;
    const state = document.createElement('span');
    state.className = `job-state ${job.state}`;
    if (job.state === 'done') {
      state.textContent = job.bytes ? `готово · ${fmtSize(job.bytes)}` : 'готово';
    } else if (job.state === 'error') {
      state.textContent = 'ошибка';
    } else if (job.state === 'canceled') {
      state.textContent = 'отменено';
    } else {
      state.textContent = jobProgressView(job).text;
    }
    row.append(title, state);

    if (job.state === 'done' && job.outFile) {
      const show = document.createElement('button');
      show.className = 'link-btn show-btn';
      show.textContent = 'в папке';
      show.title = job.outFile;
      show.addEventListener('click', async () => {
        const res = await chrome.runtime.sendMessage({ type: 'show-in-folder', path: job.outFile });
        if (!res?.ok) showError(res?.error ?? 'Не удалось открыть папку');
      });
      row.append(show);
    }

    if (job.state === 'running' || job.state === 'starting') {
      const cancel = document.createElement('button');
      cancel.className = 'cancel-btn';
      cancel.textContent = '✕';
      cancel.title = 'Отменить';
      cancel.addEventListener('click', () => {
        void chrome.runtime.sendMessage({ type: 'cancel-job', jobId: job.jobId });
      });
      row.append(cancel);
    }

    li.append(row);

    if (job.state === 'running' || job.state === 'starting') {
      const bar = document.createElement('progress');
      const { ratio } = jobProgressView(job);
      if (ratio != null) {
        bar.max = 1;
        bar.value = ratio;
      }
      li.append(bar);
    }

    if (job.state === 'error' && job.message) {
      const msg = document.createElement('div');
      msg.className = 'job-msg';
      msg.textContent = job.message.slice(0, 300);
      li.append(msg);
    }

    jobsList.append(li);
  }
}

function showError(text: string): void {
  coappStatusEl.className = 'status status-err';
  coappStatusEl.title = text;
  coappStatusEl.textContent = 'ошибка';
}

async function refresh(): Promise<void> {
  if (activeTab?.id == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'get-media', tabId: activeTab.id });
  pageThumb = res?.pageThumb;
  renderMedia(res?.items ?? []);
  renderJobs(res?.jobs ?? []);
}

async function init(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jobs-updated') renderJobs(msg.jobs ?? []);
    if (msg?.type === 'update-progress') onUpdateProgress(msg.state, msg.message);
  });

  void initUpdater();

  // Пока попап открыт, список может пополняться
  const mediaPoll = setInterval(() => void refresh(), 2000);
  window.addEventListener('unload', () => clearInterval(mediaPoll));

  $<HTMLButtonElement>('#ytdlp-page').addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'download-ytdlp',
      pageUrl: activeTab?.url,
      pageTitle: activeTab?.title,
      streams: $<HTMLSelectElement>('#ytdlp-streams').value,
    });
    if (!res?.ok) showError(res?.error ?? 'CoApp недоступен');
    setTimeout(() => (btn.disabled = false), 1500);
  });

  $<HTMLButtonElement>('#clear-jobs').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clear-jobs' });
    renderJobs(res?.jobs ?? []);
  });

  let defaultOutDir = '';
  const { outDir } = await chrome.storage.local.get({ outDir: '' });
  outDirInput.value = outDir as string;
  outDirInput.addEventListener('change', () => {
    const v = outDirInput.value.trim();
    void chrome.storage.local.set({ outDir: v });
    // Пустое поле означает папку по умолчанию — показываем её полный путь
    if (!v && defaultOutDir) outDirInput.value = defaultOutDir;
  });

  const browseBtn = $<HTMLButtonElement>('#browse-dir');
  browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pick-out-dir', current: outDirInput.value.trim() });
      if (res?.dir) outDirInput.value = res.dir;
      else if (res?.ok === false) showError(res.error ?? 'Не удалось открыть диалог выбора папки');
    } finally {
      browseBtn.disabled = false;
    }
  });

  const status = await chrome.runtime.sendMessage({ type: 'coapp-status' });
  if (status?.ok) {
    defaultOutDir = status.info?.defaultOutDir ?? '';
    if (!outDirInput.value && defaultOutDir) outDirInput.value = defaultOutDir;
    coappStatusEl.className = 'status status-ok';
    const missing: string[] = [];
    if (!status.info?.ffmpeg) missing.push('ffmpeg');
    if (!status.info?.ytdlp) missing.push('yt-dlp');
    coappStatusEl.textContent = missing.length ? `CoApp (нет: ${missing.join(', ')})` : 'CoApp';
    coappStatusEl.title = missing.length
      ? `CoApp работает, но не найдены: ${missing.join(', ')}. Запусти npm run coapp:fetch-bins`
      : `CoApp v${status.info?.version} готов`;
    if (missing.length) coappStatusEl.className = 'status status-err';
  } else {
    coappStatusEl.className = 'status status-err';
    coappStatusEl.textContent = 'CoApp не найден';
    coappStatusEl.title = `${status?.error ?? ''}\nУстанови: npm run coapp:install`.trim();
  }
}

void init();
