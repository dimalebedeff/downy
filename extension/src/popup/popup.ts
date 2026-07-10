import type { JobInfo, MediaItem, ProbeState } from '../lib/types';
import type { CutRange, StreamSelection } from '../../../shared/protocol';
import { makeCut, maskTimecode } from '../lib/cut';
import { fmtSize, jobProgressView } from '../lib/progress';
import { REPO } from '../lib/update';
import { filterPageItems, groupMediaItems, samePage } from '../lib/media-group';
import { isProbablyVideo } from '../lib/media-detect';
import { diffJobs } from '../lib/jobs-diff';
import { isUnfinished, mergeVisibleOrder } from '../lib/queue';
import { qualityOptions } from '../lib/ytdlp-formats';

type MediaGroup = ReturnType<typeof groupMediaItems>[number];

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const mediaList = $<HTMLUListElement>('#media-list');
const emptyEl = $<HTMLDivElement>('#empty');
const jobsSection = $<HTMLElement>('#jobs-section');
const jobsList = $<HTMLUListElement>('#jobs-list');
const clearJobsBtn = $<HTMLButtonElement>('#clear-jobs');
const statusDot = $<HTMLButtonElement>('#status-dot');
const statusBanner = $<HTMLDivElement>('#status-banner');
const settingsPanel = $<HTMLDivElement>('#settings-panel');
const outDirInput = $<HTMLInputElement>('#out-dir');
const ytdlpRow = $<HTMLDivElement>('#ytdlp-row');
const ytdlpBtn = $<HTMLButtonElement>('#ytdlp-page');
const footerEl = $<HTMLElement>('footer');
const kebabMenu = $<HTMLDivElement>('#kebab-menu');

interface PageVideo {
  /** Что качать yt-dlp: ссылка поста из ленты либо адрес страницы */
  url: string;
  /** Адрес вкладки, где видео нашли */
  pageHref?: string;
  title?: string;
  thumb?: string;
  probe?: ProbeState;
}

let activeTab: chrome.tabs.Tab | undefined;
let pageThumb: string | undefined;
let pageVideos: PageVideo[] = [];
let lastItems: MediaItem[] = [];
let lastJobs: JobInfo[] = [];

// Живые шкалы и подписи: jobId → элементы, которые обновляем на месте без
// перерисовки, иначе CSS-переход ширины не срабатывает и полоска дёргается.
// У одной загрузки их может быть два: шкала на карточке и строка в очереди
const liveBars = new Map<string, { fill?: HTMLDivElement; label: HTMLElement }[]>();
// Перерисовку отложили (открыт кебаб) — догоним на ближайшем поллинге
let needsRender = false;

function trackLive(jobId: string, el: { fill?: HTMLDivElement; label: HTMLElement }): void {
  const list = liveBars.get(jobId);
  if (list) list.push(el);
  else liveBars.set(jobId, [el]);
}

function updateJobProgress(job: JobInfo): void {
  const els = liveBars.get(job.jobId);
  if (!els) return;
  const { text, ratio } = jobProgressView(job);
  for (const el of els) {
    el.label.textContent = text;
    if (!el.fill) continue;
    if (ratio != null) {
      el.fill.classList.remove('indeterminate');
      el.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    } else if (!el.fill.classList.contains('indeterminate')) {
      el.fill.style.width = '';
      el.fill.classList.add('indeterminate');
    }
  }
}

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
  // Убираем распорку, которой попап подрастал под меню
  document.body.style.minHeight = '';
}

function openKebab(anchor: HTMLElement, actions: { label: string; run: () => void }[]): void {
  // Распорка прошлого меню не должна влиять на замеры нового
  document.body.style.minHeight = '';
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
  // Границы берём у документа: window.innerWidth в попапе может врать
  // (зум браузера, окно раздуто позиционированным элементом)
  const vw = document.documentElement.clientWidth;
  const w = kebabMenu.offsetWidth;
  const left = Math.max(8, Math.min(rect.right - w, vw - w - 8));
  const top = rect.bottom + 4;
  kebabMenu.style.left = `${left}px`;
  kebabMenu.style.top = `${top}px`;
  // Меню ниже края попапа — подращиваем сам попап распоркой: Chrome
  // растягивает окно под документ, фиксированное меню он не считает
  const needed = top + kebabMenu.offsetHeight + 8;
  if (needed > document.documentElement.clientHeight) {
    document.body.style.minHeight = `${needed}px`;
  }
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

/** Обложка настоящей картинкой (poster/og:image) — наш 192px-кадр из ffmpeg не годится. */
function coverUrlFor(item: MediaItem): string | undefined {
  return [item.thumb, pageThumb].find((u) => u?.startsWith('http'));
}

function downloadCover(item: MediaItem, coverUrl: string): void {
  void chrome.runtime.sendMessage({
    type: 'download-direct',
    item: {
      url: coverUrl,
      kind: 'direct',
      tabId: item.tabId,
      foundAt: Date.now(),
      pageUrl: item.pageUrl,
      pageTitle: `${itemTitle(item)} [обложка]`,
      contentType: 'image/jpeg',
    },
    streams: 'both',
  });
}

/** Обёртка селекта — рисует шторку затухания текста, не трогая рамку. */
function wrapSelect(select: HTMLSelectElement): HTMLSpanElement {
  const wrap = document.createElement('span');
  wrap.className = 'select-wrap';
  wrap.append(select);
  return wrap;
}

/** Крестик в правом верхнем углу карточки: убрать находку из списка. */
function removeBtn(urls: string[]): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'card-remove';
  btn.textContent = '✕';
  btn.title = 'Убрать из списка';
  btn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'remove-media', tabId: activeTab?.id, urls });
    void refresh();
  });
  return btn;
}

/** Поля «от – до» на карточке: повторный вызов прячет. Валидный ввод — run(cut). */
function toggleCutRow(body: HTMLElement, run: (cut: CutRange) => void): void {
  const existing = body.querySelector('.cut-row');
  if (existing) {
    existing.remove();
    return;
  }
  const row = document.createElement('div');
  row.className = 'cut-row';
  const mkInput = (ph: string, title: string): HTMLInputElement => {
    const i = document.createElement('input');
    i.placeholder = ph;
    i.title = title;
    // Поле времени: вводятся только цифры, двоеточия подставляются сами
    i.inputMode = 'numeric';
    i.addEventListener('input', () => {
      const masked = maskTimecode(i.value);
      if (i.value !== masked) i.value = masked;
    });
    return i;
  };
  const from = mkInput('0:00', 'Начало отрезка: только цифры, двоеточия подставятся сами');
  const to = mkInput('до конца', 'Конец отрезка: только цифры, двоеточия подставятся сами');
  const dash = document.createElement('span');
  dash.className = 'cut-dash';
  dash.textContent = '–';
  const go = document.createElement('button');
  go.className = 'primary cut-go';
  go.textContent = '✂';
  go.title = 'Скачать отрезок';
  const submit = (): void => {
    const cut = makeCut(from.value, to.value);
    if (!cut) {
      row.classList.add('cut-bad');
      setTimeout(() => row.classList.remove('cut-bad'), 800);
      return;
    }
    row.remove();
    run(cut);
  };
  go.addEventListener('click', submit);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  row.append(from, dash, to, go);
  body.append(row);
  from.focus();
}

/** Клик по превью качает обложку; при ховере — подсказка поверх картинки. */
function makeThumbDownloadable(thumbBox: HTMLDivElement, run: () => void): void {
  thumbBox.classList.add('thumb-dl');
  const hint = document.createElement('span');
  hint.className = 'thumb-hint';
  hint.textContent = 'Скачать обложку';
  thumbBox.append(hint);
  thumbBox.addEventListener('click', run);
}

function renderMedia(): void {
  needsRender = false;
  liveBars.clear();
  // SPA меняет ролики без перезагрузки — старьё с прошлых адресов не показываем
  const groups = groupMediaItems(filterPageItems(lastItems, activeTab?.url));
  // Страница с MSE-видео (ютуб, лента X) — свои карточки, если больше ничего
  // не поймали; показываем только найденное на текущем адресе вкладки
  const currentPageVideos = pageVideos.filter(
    (pv) => !activeTab?.url || samePage(pv.pageHref ?? pv.url, activeTab.url),
  );
  const showPageCards = groups.length === 0 && currentPageVideos.length > 0;
  lastHasMedia = groups.length > 0 || showPageCards;
  emptyEl.hidden = lastHasMedia;
  refreshDot();

  // yt-dlp: звезда пустого экрана, скромная строчка — когда медиа есть.
  // Карточки страницы сами качают через yt-dlp — дубль-строчка не нужна.
  ytdlpRow.hidden = showPageCards;
  if (!emptyEl.hidden) {
    if (ytdlpRow.parentElement !== emptyEl) emptyEl.append(ytdlpRow);
    ytdlpBtn.textContent = 'Надавить на сайт';
    ytdlpBtn.title = 'Скачать страницу через yt-dlp';
  } else {
    if (ytdlpRow.parentElement !== footerEl) footerEl.prepend(ytdlpRow);
    ytdlpBtn.textContent = 'Надавить на сайт';
    ytdlpBtn.title = 'Скачать страницу через yt-dlp';
  }

  mediaList.textContent = '';
  const matched = new Set<string>();

  if (showPageCards) {
    for (const pv of currentPageVideos) {
      const job = findJobByUrls(new Set([pv.url]));
      if (job) matched.add(job.jobId);
      mediaList.append(pageVideoCard(pv, job));
    }
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
    const cover = coverUrlFor(item);
    if (cover) makeThumbDownloadable(thumbBox, () => downloadCover(item, cover));

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

    if (job && isUnfinished(job.state)) {
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

    li.append(thumbBox, body, removeBtn([...groupUrls(group)]));
    mediaList.append(li);
  }

  renderJobs(matched);
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
  // Обложку страницы достаёт yt-dlp — работает и без превью
  makeThumbDownloadable(thumbBox, () => {
    void chrome.runtime.sendMessage({ type: 'download-thumb-ytdlp', pageUrl: pv.url, pageTitle: pv.title });
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  const probeReady = pv.probe?.status === 'ready' ? pv.probe : undefined;

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = probeReady?.title?.trim() || pv.title?.trim() || pv.url;
  title.title = pv.url;
  body.append(title);

  if (job && isUnfinished(job.state)) {
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

    // Выбор качества из разведки; пока она едет — «Лучшее» работает сразу.
    // Разведка доехала — сразу подставляем конкретное лучшее качество с весом
    const select = document.createElement('select');
    select.title = 'Качество';
    const opts = probeReady ? qualityOptions(probeReady.formats) : [];
    if (opts.length === 0) select.append(new Option('Лучшее', ''));
    if (probeReady) {
      for (const q of opts) {
        const opt = new Option(q.label, String(q.maxHeight));
        // В имя файла идёт «1080p60», без веса
        opt.dataset.q = q.label.split(' · ')[0];
        select.append(opt);
      }
    } else if (pv.probe?.status === 'pending') {
      // Точки бегут интервалом в init — селект живой, пока идёт разведка
      const opt = new Option('Пробив', '', true, true);
      opt.disabled = true;
      opt.dataset.probing = '1';
      select.append(opt);
    }

    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Скачать';
    const start = async (streams: StreamSelection, cut?: CutRange): Promise<void> => {
      btn.disabled = true;
      const res = await chrome.runtime.sendMessage({
        type: 'download-ytdlp',
        pageUrl: pv.url,
        pageTitle: pv.title,
        streams,
        maxHeight: select.value ? Number(select.value) : undefined,
        qualityLabel: select.selectedOptions[0]?.dataset.q,
        cut,
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
        { label: 'Скачать отрезок…', run: () => toggleCutRow(body, (cut) => void start('both', cut)) },
        {
          label: 'Скачать обложку',
          run: () => {
            void chrome.runtime.sendMessage({ type: 'download-thumb-ytdlp', pageUrl: pv.url, pageTitle: pv.title });
          },
        },
        { label: 'Копировать ссылку', run: () => void navigator.clipboard.writeText(pv.url) },
      ]);
    });

    row.append(btn, wrapSelect(select), kebab);
    body.append(row);
  }

  li.append(thumbBox, body, removeBtn([pv.url]));
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
  const start = (streams: StreamSelection, cut?: CutRange): void => {
    void download(chosen(), item.kind === 'hls' ? select : null, streams, btn, cut);
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
        {
          label: 'Скачать отрезок…',
          run: () => {
            const body = kebab.closest<HTMLElement>('.card-body');
            if (body) toggleCutRow(body, (cut) => start('both', cut));
          },
        },
      );
    }
    const coverUrl = coverUrlFor(item);
    if (coverUrl) {
      actions.push({ label: 'Скачать обложку', run: () => downloadCover(item, coverUrl) });
    }
    actions.push({
      label: 'Копировать ссылку',
      run: () => void navigator.clipboard.writeText(item.kind === 'hls' && select ? select.value : chosen().url),
    });
    openKebab(kebab, actions);
  });

  row.append(btn);
  if (select) row.append(wrapSelect(select));
  row.append(kebab);
  return row;
}

function smallBtn(cls: string, glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = glyph;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function cancelBtn(job: JobInfo): HTMLButtonElement {
  return smallBtn('cancel-btn', '✕', 'Отменить', () => {
    void chrome.runtime.sendMessage({ type: 'cancel-job', jobId: job.jobId });
  });
}

function pauseBtn(job: JobInfo): HTMLButtonElement {
  return smallBtn('pause-btn', '⏸', 'Пауза', () => {
    void chrome.runtime.sendMessage({ type: 'pause-job', jobId: job.jobId });
  });
}

function resumeBtn(job: JobInfo): HTMLButtonElement {
  return smallBtn('pause-btn', '▶', 'Продолжить', () => {
    void chrome.runtime.sendMessage({ type: 'resume-job', jobId: job.jobId });
  });
}

/** Незавершённая загрузка в карточке: шкала с кометой, пауза, отмена. */
function jobLine(job: JobInfo): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'job-line';

  if (job.state === 'queued') {
    const label = document.createElement('span');
    label.className = 'job-text queued';
    label.textContent = 'в очереди';
    line.append(label, cancelBtn(job));
    return line;
  }

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  const { text, ratio } = jobProgressView(job);
  if (ratio != null) fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  else if (job.state !== 'paused') fill.classList.add('indeterminate');
  bar.append(fill);

  const label = document.createElement('span');
  label.className = 'job-text';

  // Цифры и кнопки — этажом выше, полоска — во всю ширину под ними
  line.classList.add('stacked');
  const top = document.createElement('div');
  top.className = 'job-top';

  if (job.state === 'paused') {
    bar.classList.add('paused');
    label.textContent = 'пауза';
    top.append(label, resumeBtn(job), cancelBtn(job));
  } else {
    label.textContent = text;
    trackLive(job.jobId, { fill, label });
    top.append(label, pauseBtn(job), cancelBtn(job));
  }
  line.append(top, bar);
  return line;
}

function doneLine(job: JobInfo): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'job-line';
  const label = document.createElement('span');
  label.className = 'job-text done';
  // Размера нет — не пишем ничего: сам факт завершения виден по кнопке папки
  label.textContent = fmtSize(job.bytes);
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
  cut?: CutRange,
): Promise<void> {
  btn.disabled = true;
  try {
    if (item.kind === 'direct') {
      const res = await chrome.runtime.sendMessage({ type: 'download-direct', item, streams, cut });
      if (!res?.ok) showError(res?.error ?? 'Не удалось начать скачивание');
    } else {
      const variantUrl = select?.value;
      const variantLabel = select?.selectedOptions[0]?.textContent ?? undefined;
      const res = await chrome.runtime.sendMessage({ type: 'download-hls', item, variantUrl, variantLabel, streams, cut });
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

// ---------- Загрузки: очередь (активная + ждущие, драг) и завершённые ----------

let dragId: string | null = null;

/** Строка очереди; порядок — сверху вниз, активная первой.
 *  withBar=false — у загрузки есть карточка, полоска живёт там. */
function queueRow(job: JobInfo, withBar: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tail-job queue-row';
  li.dataset.jobId = job.jobId;

  const row = document.createElement('div');
  row.className = 'tail-row';

  // Обложки и мелкое аудио идут мимо очереди — их не потаскаешь
  if (!job.noQueue) {
    li.draggable = true;
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Тащи, чтобы поменять порядок';
    row.append(handle);
    li.addEventListener('dragstart', (e) => {
      dragId = job.jobId;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', job.jobId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragId = null;
      const visible = [...jobsList.querySelectorAll<HTMLLIElement>('li.queue-row[draggable="true"]')]
        .map((el) => el.dataset.jobId ?? '')
        .filter(Boolean);
      // Карточные загрузки в списке не видны — мержим, чтобы реордер хвоста
      // не задвинул их в конец и не вытеснил активную
      const full = lastJobs.filter((j) => isUnfinished(j.state) && !j.noQueue).map((j) => j.jobId);
      void chrome.runtime.sendMessage({ type: 'reorder-jobs', order: mergeVisibleOrder(full, visible) });
    });
  }

  const title = document.createElement('span');
  title.className = 'tail-title';
  title.textContent = job.label;
  title.title = job.outFile ?? job.label;

  const state = document.createElement('span');
  state.className = 'job-text';
  row.append(title, state);

  if (job.state === 'queued') {
    state.classList.add('queued');
    state.textContent = 'в очереди';
    row.append(cancelBtn(job));
  } else if (job.state === 'paused') {
    state.textContent = 'пауза';
    row.append(resumeBtn(job), cancelBtn(job));
  } else {
    state.textContent = jobProgressView(job).text;
    if (!job.noQueue) row.append(pauseBtn(job));
    row.append(cancelBtn(job));
  }

  li.append(row);

  if (job.state !== 'queued' && withBar) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    const { ratio } = jobProgressView(job);
    if (ratio != null) fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    else if (job.state !== 'paused') fill.classList.add('indeterminate');
    if (job.state === 'paused') bar.classList.add('paused');
    bar.append(fill);
    li.append(bar);
    if (job.state !== 'paused') trackLive(job.jobId, { fill, label: state });
  } else if (job.state !== 'queued' && job.state !== 'paused') {
    // Без полоски цифры всё равно живые
    trackLive(job.jobId, { label: state });
  }

  return li;
}

function finishedRow(job: JobInfo): HTMLLIElement {
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
    state.textContent = fmtSize(job.bytes);
  } else if (job.state === 'canceled') {
    state.classList.add('err');
    state.textContent = 'отменено';
  } else {
    state.classList.add('err');
    state.textContent = 'ошибка';
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

  li.append(row);

  if (job.state === 'error' && job.message) {
    const msg = document.createElement('div');
    msg.className = 'job-msg';
    msg.textContent = job.message.slice(0, 300);
    li.append(msg);
  }

  return li;
}

function renderJobs(matched: Set<string>): void {
  hasActiveJobs = lastJobs.some((j) => j.state === 'running' || j.state === 'starting' || j.state === 'queued');
  syncUpdateBtn();
  // Очередь целиком, сверху вниз в порядке скачивания — по ней видно, кто
  // качается и кто следующий. У карточных загрузок полоска на карточке,
  // в строке — только цифры. Завершённые без карточки — хвостом
  const queue = lastJobs.filter((j) => isUnfinished(j.state));
  const finished = lastJobs.filter((j) => !isUnfinished(j.state) && !matched.has(j.jobId));
  jobsSection.hidden = queue.length === 0 && finished.length === 0;
  clearJobsBtn.hidden = finished.length === 0;
  jobsList.textContent = '';
  for (const job of queue) jobsList.append(queueRow(job, !matched.has(job.jobId)));
  for (const job of finished) jobsList.append(finishedRow(job));
}

// ---------- Инициализация ----------

let mediaSnapshot = '';

async function refresh(): Promise<void> {
  if (activeTab?.id == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'get-media', tabId: activeTab.id });
  pageThumb = res?.pageThumb;
  pageVideos = res?.pageVideos ?? [];
  lastItems = res?.items ?? [];
  const jobs: JobInfo[] = res?.jobs ?? [];
  const jobsKind = diffJobs(lastJobs, jobs);
  lastJobs = jobs;
  // Перерисовка стирает CSS-переходы и мигает превью — делаем её только
  // когда реально изменился состав карточек, а не цифры прогресса
  const snap = JSON.stringify([pageThumb, pageVideos, lastItems]);
  if (snap !== mediaSnapshot || jobsKind === 'structural' || needsRender) {
    mediaSnapshot = snap;
    renderMedia();
  } else if (jobsKind === 'progress') {
    for (const j of jobs) updateJobProgress(j);
  }
}

async function init(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jobs-updated') {
      const jobs: JobInfo[] = msg.jobs ?? [];
      const kind = diffJobs(lastJobs, jobs);
      lastJobs = jobs;
      if (kind === 'progress') {
        for (const j of jobs) updateJobProgress(j);
      } else if (kind === 'structural') {
        if (kebabMenu.hidden && !dragId) renderMedia();
        else needsRender = true;
      }
    }
    if (msg?.type === 'update-progress') onUpdateProgress(msg.state, msg.message);
  });

  void initUpdater();

  // Пока попап открыт, список может пополняться; открытое меню и драг не дёргаем
  const mediaPoll = setInterval(() => {
    if (kebabMenu.hidden && !dragId) void refresh();
  }, 2000);
  window.addEventListener('unload', () => clearInterval(mediaPoll));

  // Бегущие точки «Пробив…», пока едет разведка качеств
  let probeDotsN = 0;
  setInterval(() => {
    probeDotsN = (probeDotsN + 1) % 4;
    const text = `Пробив${'.'.repeat(probeDotsN)}`;
    for (const el of document.querySelectorAll('[data-probing]')) el.textContent = text;
  }, 400);

  // Перетаскивание строк очереди: тащим над списком, порядок уедет на dragend
  jobsList.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const dragging = jobsList.querySelector<HTMLLIElement>('li.dragging');
    if (!dragging) return;
    const rows = [...jobsList.querySelectorAll<HTMLLIElement>('li.queue-row[draggable="true"]:not(.dragging)')];
    const next = rows.find((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
    if (next) jobsList.insertBefore(dragging, next);
    else rows.at(-1)?.after(dragging);
  });
  jobsList.addEventListener('drop', (e) => e.preventDefault());

  statusDot.addEventListener('click', () => {
    if (!statusBanner.textContent) return; // статус ещё не доехал — нечего показывать
    statusBanner.hidden = !statusBanner.hidden;
  });

  $<HTMLButtonElement>('#settings-btn').addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  ytdlpBtn.addEventListener('click', async (e) => {
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

  clearJobsBtn.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clear-jobs' });
    lastJobs = res?.jobs ?? [];
    renderMedia();
  });

  const askDirBox = $<HTMLInputElement>('#ask-dir');
  const { askDirEveryTime } = await chrome.storage.local.get({ askDirEveryTime: false });
  askDirBox.checked = askDirEveryTime as boolean;
  askDirBox.addEventListener('change', () => {
    void chrome.storage.local.set({ askDirEveryTime: askDirBox.checked });
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
