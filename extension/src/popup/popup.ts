import type { JobInfo, MediaItem } from '../lib/types';
import { fmtSize, jobProgressView } from '../lib/progress';

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
  emptyEl.hidden = items.length > 0;
  for (const item of items) {
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
    }

    const btn = document.createElement('button');
    btn.textContent = 'Скачать';
    btn.addEventListener('click', () => void download(item, select, btn));
    row2.append(btn);

    body.append(row1, row2);
    li.append(thumbBox, body);
    mediaList.append(li);
  }
}

async function download(item: MediaItem, select: HTMLSelectElement | null, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    if (item.kind === 'direct') {
      const res = await chrome.runtime.sendMessage({ type: 'download-direct', item });
      if (!res?.ok) showError(res?.error ?? 'Не удалось начать скачивание');
    } else {
      const variantUrl = select?.value;
      const variantLabel = select?.selectedOptions[0]?.textContent ?? undefined;
      const res = await chrome.runtime.sendMessage({ type: 'download-hls', item, variantUrl, variantLabel });
      if (!res?.ok) showError(res?.error ?? 'CoApp недоступен');
    }
  } finally {
    setTimeout(() => (btn.disabled = false), 1000);
  }
}

function renderJobs(jobs: JobInfo[]): void {
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
  });

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
    });
    if (!res?.ok) showError(res?.error ?? 'CoApp недоступен');
    setTimeout(() => (btn.disabled = false), 1500);
  });

  $<HTMLButtonElement>('#clear-jobs').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clear-jobs' });
    renderJobs(res?.jobs ?? []);
  });

  const { outDir } = await chrome.storage.local.get({ outDir: '' });
  outDirInput.value = outDir as string;
  outDirInput.addEventListener('change', () => {
    void chrome.storage.local.set({ outDir: outDirInput.value.trim() });
  });

  const status = await chrome.runtime.sendMessage({ type: 'coapp-status' });
  if (status?.ok) {
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
