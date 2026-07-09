import type { JobInfo, MediaItem } from '../lib/types';
import type { StreamSelection } from '../../../shared/protocol';
import { fmtSize, jobProgressView } from '../lib/progress';
import { REPO } from '../lib/update';
import { groupMediaItems } from '../lib/media-group';
import { isProbablyVideo } from '../lib/media-detect';

type MediaGroup = ReturnType<typeof groupMediaItems>[number];

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const mediaList = $<HTMLUListElement>('#media-list');
const emptyEl = $<HTMLDivElement>('#empty');
const jobsSection = $<HTMLElement>('#jobs-section');
const jobsList = $<HTMLUListElement>('#jobs-list');
const statusDot = $<HTMLButtonElement>('#status-dot');
const statusBanner = $<HTMLDivElement>('#status-banner');
const settingsPanel = $<HTMLDivElement>('#settings-panel');
const outDirInput = $<HTMLInputElement>('#out-dir');
const ytdlpRow = $<HTMLDivElement>('#ytdlp-row');
const footerEl = $<HTMLElement>('footer');
const kebabMenu = $<HTMLDivElement>('#kebab-menu');

interface PageVideo {
  url: string;
  title?: string;
  thumb?: string;
}

let activeTab: chrome.tabs.Tab | undefined;
let pageThumb: string | undefined;
let pageVideo: PageVideo | undefined;
let lastItems: MediaItem[] = [];
let lastJobs: JobInfo[] = [];

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

// ---------- Индикатор: зелёный — есть что качать, серый — пусто, красный — беда ----------

let coappOk: boolean | null = null; // null — ещё проверяем
let hardError = false;
let lastHasMedia = false;

function refreshDot(): void {
  const kind = hardError || coappOk === false ? 'err' : coappOk && lastHasMedia ? 'ok' : 'unknown';
  statusDot.className = `dot dot-${kind}`;
  statusDot.title =
    kind === 'ok' ? 'Медиа найдено, помощник на связи'
    : kind === 'err' ? 'Что-то не работает — нажми'
    : 'Медиа на вкладке пока нет';
}

function setBanner(text: string, isErr: boolean, show: boolean): void {
  statusBanner.textContent = text;
  statusBanner.classList.toggle('err', isErr);
  if (show) statusBanner.hidden = false;
}

/** Настоящая поломка — красная точка и пояснение выскакивает само. */
function showError(text: string): void {
  hardError = true;
  setBanner(text, true, true);
  refreshDot();
}

// ---------- Сопоставление карточка ↔ загрузка ----------

function groupUrls(group: MediaGroup): Set<string> {
  const urls = new Set<string>([group.primary.url]);
  for (const m of group.members) urls.add(m.url);
  for (const v of group.primary.variants ?? []) urls.add(v.url);
  return urls;
}

/** Последняя загрузка по URL; активная имеет приоритет над завершённой. */
function findJobByUrls(urls: Set<string>): JobInfo | undefined {
  const mine = lastJobs.filter((j) => j.sourceUrl && urls.has(j.sourceUrl));
  return (
    mine.filter((j) => j.state === 'running' || j.state === 'starting').at(-1) ?? mine.at(-1)
  );
}

function findJob(group: MediaGroup): JobInfo | undefined {
  return findJobByUrls(groupUrls(group));
}

// ---------- Кебаб-меню ----------

function closeKebab(): void {
  kebabMenu.hidden = true;
}

function openKebab(anchor: HTMLElement, actions: { label: string; run: () => void }[]): void {
  kebabMenu.textContent = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', () => {
      closeKebab();
      a.run();
    });
    kebabMenu.append(b);
  }
  kebabMenu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - kebabMenu.offsetWidth, window.innerWidth - kebabMenu.offsetWidth - 8));
  const top = Math.min(rect.bottom + 4, window.innerHeight - kebabMenu.offsetHeight - 8);
  kebabMenu.style.left = `${left}px`;
  kebabMenu.style.top = `${top}px`;
}

document.addEventListener('click', (e) => {
  if (!kebabMenu.hidden && !kebabMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.kebab')) {
    closeKebab();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeKebab();
});

// ---------- Карточки медиа ----------

function renderMedia(): void {
  const groups = groupMediaItems(lastItems);
  // Страница с MSE-видео (ютуб и ко) — своя карточка, если больше ничего не поймали
  const showPageCard = groups.length === 0 && !!pageVideo?.url;
  lastHasMedia = groups.length > 0 || showPageCard;
  emptyEl.hidden = lastHasMedia;
  refreshDot();

  // yt-dlp: звезда пустого экрана, скромная строчка — когда медиа есть.
  // Карточка страницы сама качает через yt-dlp — дубль-строчка не нужна.
  ytdlpRow.hidden = showPageCard;
  if (!emptyEl.hidden) {
    if (ytdlpRow.parentElement !== emptyEl) emptyEl.append(ytdlpRow);
  } else if (ytdlpRow.parentElement !== footerEl) {
    footerEl.prepend(ytdlpRow);
  }

  mediaList.textContent = '';
  const matched = new Set<string>();

  if (showPageCard && pageVideo) {
    const job = findJobByUrls(new Set([pageVideo.url]));
    if (job) matched.add(job.jobId);
    mediaList.append(pageVideoCard(pageVideo, job));
  }

  for (const group of groups) {
    const item = group.primary;
    const job = findJob(group);
    if (job) matched.add(job.jobId);

    const li = document.createElement('li');
    li.className = 'card';

    const thumbBox = document.createElement('div');
    thumbBox.className = 'thumb';
    const thumbSrc = item.thumb ?? pageThumb;
    if (thumbSrc) {
      const img = document.createElement('img');
      img.src = thumbSrc;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      thumbBox.append(img);
    } else {
      thumbBox.textContent = item.kind !== 'direct' || item.contentType?.startsWith('video') ? '🎬' : '🎵';
    }
    const duration = fmtDuration(item.durationSec);
    if (duration) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = duration;
      thumbBox.append(badge);
    }

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = itemTitle(item);
    // Инженерное — в тултип: URL и формат потока
    const kindLabel = item.kind === 'hls' ? 'HLS' : item.kind === 'dash' ? 'DASH' : item.contentType ?? '';
    title.title = [item.url, kindLabel].filter(Boolean).join('\n');
    body.append(title);

    const metaParts: string[] = [];
    if (item.size) metaParts.push(fmtSize(item.size));
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.textContent = metaParts.join(' · ');
      body.append(meta);
    }

    if (job && (job.state === 'running' || job.state === 'starting')) {
      body.append(jobLine(job));
    } else if (job && job.state === 'done') {
      body.append(doneLine(job));
    } else {
      if (job && job.state === 'error' && job.message) {
        const msg = document.createElement('div');
        msg.className = 'job-msg';
        msg.textContent = job.message.slice(0, 300);
        body.append(msg);
      }
      body.append(actionsRow(group));
    }

    li.append(thumbBox, body);
    mediaList.append(li);
  }

  renderTailJobs(lastJobs.filter((j) => !matched.has(j.jobId)));
}

/** Карточка «на странице есть видео» (MSE/blob) — качаем страницу через yt-dlp. */
function pageVideoCard(pv: PageVideo, job: JobInfo | undefined): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'card';

  const thumbBox = document.createElement('div');
  thumbBox.className = 'thumb';
  const thumbSrc = pv.thumb ?? pageThumb;
  if (thumbSrc) {
    const img = document.createElement('img');
    img.src = thumbSrc;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    thumbBox.append(img);
  } else {
    thumbBox.textContent = '🎬';
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = pv.title?.trim() || pv.url;
  title.title = pv.url;
  body.append(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = 'Видео на странице · скачаю через yt-dlp';
  body.append(meta);

  if (job && (job.state === 'running' || job.state === 'starting')) {
    body.append(jobLine(job));
  } else if (job && job.state === 'done') {
    body.append(doneLine(job));
  } else {
    if (job && job.state === 'error' && job.message) {
      const msg = document.createElement('div');
      msg.className = 'job-msg';
      msg.textContent = job.message.slice(0, 300);
      body.append(msg);
    }

    const row = document.createElement('div');
    row.className = 'card-actions';

    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Скачать';
    const start = async (streams: StreamSelection): Promise<void> => {
      btn.disabled = true;
      const res = await chrome.runtime.sendMessage({
        type: 'download-ytdlp',
        pageUrl: pv.url,
        pageTitle: pv.title,
        streams,
      });
      if (!res?.ok) showError(res?.error ?? 'Помощник недоступен');
      setTimeout(() => (btn.disabled = false), 1500);
    };
    btn.addEventListener('click', () => void start('both'));

    const kebab = document.createElement('button');
    kebab.className = 'kebab';
    kebab.textContent = '⋮';
    kebab.title = 'Ещё';
    kebab.addEventListener('click', () => {
      openKebab(kebab, [
        { label: 'Скачать только видео', run: () => void start('video') },
        { label: 'Скачать только звук', run: () => void start('audio') },
        { label: 'Копировать ссылку', run: () => void navigator.clipboard.writeText(pv.url) },
      ]);
    });

    row.append(btn, kebab);
    body.append(row);
  }

  li.append(thumbBox, body);
  return li;
}

/** Ряд действий: качество (если есть варианты), «Скачать», кебаб. */
function actionsRow(group: MediaGroup): HTMLDivElement {
  const item = group.primary;
  const row = document.createElement('div');
  row.className = 'card-actions';

  let select: HTMLSelectElement | null = null;
  if (item.kind === 'hls' && item.variants && item.variants.length > 0) {
    select = document.createElement('select');
    select.title = 'Качество';
    for (const v of item.variants) {
      const opt = document.createElement('option');
      opt.value = v.url;
      opt.textContent = v.label;
      select.append(opt);
    }
  } else if (item.kind === 'direct' && group.members.length > 1) {
    // Варианты одного видео (разные качества) — один пункт с выбором
    select = document.createElement('select');
    select.title = 'Вариант файла';
    for (const [i, m] of group.members.entries()) {
      const opt = document.createElement('option');
      opt.value = m.url;
      opt.textContent = fmtSize(m.size) || m.contentType?.split('/')[1] || `вариант ${i + 1}`;
      select.append(opt);
    }
  }

  const chosen = (): MediaItem =>
    item.kind === 'direct' && select
      ? group.members.find((m) => m.url === select.value) ?? item
      : item;

  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Скачать';
  const start = (streams: StreamSelection): void => {
    void download(chosen(), item.kind === 'hls' ? select : null, streams, btn);
  };
  btn.addEventListener('click', () => start('both'));

  const kebab = document.createElement('button');
  kebab.className = 'kebab';
  kebab.textContent = '⋮';
  kebab.title = 'Ещё';
  const isVideo = item.kind !== 'direct' || isProbablyVideo(item.url, item.contentType);
  kebab.addEventListener('click', () => {
    const actions: { label: string; run: () => void }[] = [];
    if (isVideo) {
      actions.push(
        { label: 'Скачать только видео', run: () => start('video') },
        { label: 'Скачать только звук', run: () => start('audio') },
      );
    }
    actions.push({
      label: 'Копировать ссылку',
      run: () => void navigator.clipboard.writeText(item.kind === 'hls' && select ? select.value : chosen().url),
    });
    openKebab(kebab, actions);
  });

  row.append(btn);
  if (select) row.append(select);
  row.append(kebab);
  return row;
}

/** Живая загрузка: дышащая жёлтым шкала, проценты, отмена. */
function jobLine(job: JobInfo): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'job-line';

  const bar = document.createElement('div');
  bar.className = 'bar live';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  const { text, ratio } = jobProgressView(job);
  if (ratio != null) fill.style.width = `${Math.round(ratio * 100)}%`;
  else fill.classList.add('indeterminate');
  bar.append(fill);

  const label = document.createElement('span');
  label.className = 'job-text';
  label.textContent = text;

  const cancel = document.createElement('button');
  cancel.className = 'cancel-btn';
  cancel.textContent = '✕';
  cancel.title = 'Отменить';
  cancel.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'cancel-job', jobId: job.jobId });
  });

  line.append(bar, label, cancel);
  return line;
}

function doneLine(job: JobInfo): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'job-line';
  const label = document.createElement('span');
  label.className = 'job-text done';
  label.textContent = job.bytes ? `Готово · ${fmtSize(job.bytes)}` : 'Готово';
  line.append(label);
  if (job.outFile) {
    const show = document.createElement('button');
    show.className = 'link-btn show-btn';
    show.textContent = 'Показать в папке';
    show.title = job.outFile;
    show.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'show-in-folder', path: job.outFile });
      if (!res?.ok) showError(res?.error ?? 'Не удалось открыть папку');
    });
    line.append(show);
  }
  return line;
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
      if (!res?.ok) showError(res?.error ?? 'Помощник недоступен');
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
  const versionEl = $<HTMLAnchorElement>('#version');
  versionEl.textContent = `YaDaun v${chrome.runtime.getManifest().version}`;
  versionEl.href = `https://github.com/${REPO}`;
  versionEl.title = 'Открыть проект на GitHub';
  const status = await chrome.runtime.sendMessage({ type: 'check-update' });
  if (!status?.available) return;
  updateBtn.hidden = false;
  if (status.updating) {
    // Обновление запустили из прошлого попапа — показываем процесс, а не кнопку
    updating = true;
    updateBtn.disabled = true;
    updateBtn.textContent = 'Устанавливаю…';
  } else {
    updateBtn.textContent = `Обновить YaDaun до ${status.tag}`;
    syncUpdateBtn();
  }
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

// ---------- Хвосты: загрузки без карточки (другие вкладки, yt-dlp, старое) ----------

function renderTailJobs(jobs: JobInfo[]): void {
  hasActiveJobs = lastJobs.some((j) => j.state === 'running' || j.state === 'starting');
  syncUpdateBtn();
  jobsSection.hidden = jobs.length === 0;
  jobsList.textContent = '';
  for (const job of jobs) {
    const li = document.createElement('li');
    li.className = 'tail-job';

    const row = document.createElement('div');
    row.className = 'tail-row';
    const title = document.createElement('span');
    title.className = 'tail-title';
    title.textContent = job.label;
    title.title = job.outFile ?? job.label;
    const state = document.createElement('span');
    state.className = 'job-text';
    if (job.state === 'done') {
      state.classList.add('done');
      state.textContent = job.bytes ? `готово · ${fmtSize(job.bytes)}` : 'готово';
    } else if (job.state === 'error') {
      state.classList.add('err');
      state.textContent = 'ошибка';
    } else if (job.state === 'canceled') {
      state.classList.add('err');
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
      const bar = document.createElement('div');
      bar.className = 'bar live';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      const { ratio } = jobProgressView(job);
      if (ratio != null) fill.style.width = `${Math.round(ratio * 100)}%`;
      else fill.classList.add('indeterminate');
      bar.append(fill);
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

// ---------- Инициализация ----------

async function refresh(): Promise<void> {
  if (activeTab?.id == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'get-media', tabId: activeTab.id });
  pageThumb = res?.pageThumb;
  pageVideo = res?.pageVideo;
  lastItems = res?.items ?? [];
  lastJobs = res?.jobs ?? [];
  renderMedia();
}

async function init(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jobs-updated') {
      lastJobs = msg.jobs ?? [];
      if (kebabMenu.hidden) renderMedia();
    }
    if (msg?.type === 'update-progress') onUpdateProgress(msg.state, msg.message);
  });

  void initUpdater();

  // Пока попап открыт, список может пополняться; открытое меню не дёргаем
  const mediaPoll = setInterval(() => {
    if (kebabMenu.hidden) void refresh();
  }, 2000);
  window.addEventListener('unload', () => clearInterval(mediaPoll));

  statusDot.addEventListener('click', () => {
    statusBanner.hidden = !statusBanner.hidden;
  });

  $<HTMLButtonElement>('#settings-btn').addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  $<HTMLButtonElement>('#ytdlp-page').addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'download-ytdlp',
      pageUrl: activeTab?.url,
      pageTitle: activeTab?.title,
      streams: $<HTMLSelectElement>('#ytdlp-streams').value,
    });
    if (!res?.ok) showError(res?.error ?? 'Помощник недоступен');
    setTimeout(() => (btn.disabled = false), 1500);
  });

  $<HTMLButtonElement>('#clear-jobs').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clear-jobs' });
    lastJobs = res?.jobs ?? [];
    renderMedia();
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
    const missing: string[] = [];
    if (!status.info?.ffmpeg) missing.push('ffmpeg');
    if (!status.info?.ytdlp) missing.push('yt-dlp');
    if (missing.length) {
      coappOk = false;
      setBanner(`Помощник работает, но не хватает: ${missing.join(', ')}.\nЗапусти npm run coapp:fetch-bins в папке расширения.`, true, true);
    } else {
      coappOk = true;
      setBanner(`Помощник YaDaun v${status.info?.version} на связи — ffmpeg и yt-dlp на месте.`, false, false);
    }
  } else {
    coappOk = false;
    setBanner(`Помощник не отвечает — скачивание работать не будет.\nУстанови его: npm run coapp:install.\n${status?.error ?? ''}`.trim(), true, true);
  }
  refreshDot();
}

void init();
