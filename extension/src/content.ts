// Две работы: пассивно ловит медиа из DOM (теги video/audio/source) вместе с
// превью — poster, кадр из играющего видео, обложка страницы; и держит прицел,
// которым медиа выбирают кликом прямо на странице.
// Стримы через MSE (blob:) в первую часть не попадают — их видит background
// по сети, а прицел отдаёт такие ролики yt-dlp по адресу поста.

import { bestFromSrcset } from './lib/pick';

interface DomMediaEntry {
  url: string;
  thumb?: string;
}

const reported = new Map<string, string | undefined>(); // url -> отправленный thumb
let sentPageThumb: string | undefined;
// Что уже сообщили про MSE-видео: какой пост и было ли превью
let sentMse: { key: string; hasThumb: boolean } | null = null;
let mseHref = location.href; // SPA меняет ролик без перезагрузки — начинаем сначала

function absUrl(raw: string): string | null {
  try {
    const abs = new URL(raw, location.href).toString();
    return abs.startsWith('http') ? abs : null; // blob:, data: и т.п. пропускаем
  } catch {
    return null;
  }
}

function pageThumb(): string | undefined {
  const meta =
    document.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[property="og:image:url"]') ??
    document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]');
  const link = document.querySelector<HTMLLinkElement>('link[rel="image_src"]');
  const raw = meta?.content || link?.href || '';
  return raw ? absUrl(raw) ?? undefined : undefined;
}

/** Кадр из видео. Не сработает для cross-origin видео без CORS (canvas taint). */
function captureFrame(video: HTMLVideoElement): string | undefined {
  if (video.readyState < 2 || !video.videoWidth) return undefined;
  try {
    const canvas = document.createElement('canvas');
    const w = 160;
    canvas.width = w;
    canvas.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return undefined; // tainted canvas
  }
}

function mediaThumb(el: HTMLElement): string | undefined {
  const video =
    el instanceof HTMLVideoElement ? el
    : el instanceof HTMLSourceElement && el.parentElement instanceof HTMLVideoElement ? el.parentElement
    : null;
  if (!video) return undefined;
  const poster = video.getAttribute('poster');
  if (poster) {
    const abs = absUrl(poster);
    if (abs) return abs;
  }
  return captureFrame(video);
}

/** Постоянная ссылка на пост с видео (лента X и подобных):
 *  yt-dlp не умеет качать /home, ему нужен адрес конкретного поста. */
function postUrl(v: HTMLElement): string | undefined {
  const a = v.closest('article')?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  return a ? absUrl(a.href) ?? undefined : undefined;
}

/** Видео, играющее через MSE (blob:) — файл руками не взять, но yt-dlp справится.
 *  В ленте видео много — берём играющее, а не первое попавшееся. */
function mseVideo(): { url?: string; thumb?: string } | null {
  let fallback: HTMLVideoElement | null = null;
  for (const v of document.querySelectorAll('video')) {
    const src = v.currentSrc || v.src || '';
    if (!src.startsWith('blob:')) continue;
    if (!v.paused) return { url: postUrl(v), thumb: mediaThumb(v) };
    fallback ??= v;
  }
  return fallback ? { url: postUrl(fallback), thumb: mediaThumb(fallback) } : null;
}

function collect(): void {
  const media: DomMediaEntry[] = [];
  const els = document.querySelectorAll<HTMLElement>('video, audio, source');
  for (const el of els) {
    const raw = (el as HTMLMediaElement).currentSrc || el.getAttribute('src') || '';
    if (!raw) continue;
    const abs = absUrl(raw);
    if (!abs) continue;
    const thumb = mediaThumb(el);
    // Повторно отправляем, только если появилось превью, которого не было
    if (reported.has(abs) && (reported.get(abs) || !thumb)) continue;
    reported.set(abs, thumb);
    media.push({ url: abs, thumb });
  }
  const pt = pageThumb();
  const pageThumbChanged = pt !== sentPageThumb;
  if (location.href !== mseHref) {
    mseHref = location.href;
    sentMse = null;
  }
  const mse = mseVideo();
  // Про MSE сообщаем при появлении, смене поста (скролл ленты) и когда
  // дозрело превью; исчезновение не откатываем
  const mseChanged =
    mse != null && (sentMse?.key !== (mse.url ?? '') || (!sentMse.hasThumb && !!mse.thumb));
  if (media.length || pageThumbChanged || mseChanged) {
    sentPageThumb = pt;
    if (mseChanged && mse) sentMse = { key: mse.url ?? '', hasThumb: !!mse.thumb };
    void chrome.runtime
      .sendMessage({
        type: 'dom-media',
        media,
        mseVideo: mseChanged ? mse : undefined,
        pageThumb: pt,
        pageTitle: document.title,
        pageUrl: location.href,
      })
      .catch(() => {});
  }
}

/** Скрипт живёт во всех фреймах ради прицела, но детект медиа оставляем
 *  главному: во фреймах сидит реклама, её ролики засорили бы список. */
const TOP_FRAME = window.top === window;

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleCollect(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    collect();
  }, 1000);
}

if (TOP_FRAME) {
  collect();

  new MutationObserver(scheduleCollect).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'poster'],
  });

  document.addEventListener('play', scheduleCollect, true);
  document.addEventListener('loadedmetadata', scheduleCollect, true);
}

// ---------- Прицел: выбор медиа кликом прямо на странице ----------
//
// Список в попапе плох там, где на странице десяток роликов: карточки не
// отличить друг от друга. Прицел заходит с другой стороны — тыкаешь в то, что
// видишь. Режим липкий: картинки обычно таскают пачкой.

/** Меньше этого — иконка интерфейса, а не контент; за такое цепляться нечего */
const MIN_PICK_SIZE = 100;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i;

interface PickTarget {
  el: Element;
  kind: 'image' | 'video';
  /** Прямой адрес файла или потока */
  url?: string;
  /** У видео через MSE адреса нет — качаем страницу поста через yt-dlp */
  postUrl?: string;
}

interface PickVariant {
  label: string;
  url?: string;
  streams?: string;
}


let pickerOn = false;
let hovered: PickTarget | null = null;
let shadow: ShadowRoot | null = null;
let frameEl: HTMLDivElement | null = null;
let tagEl: HTMLSpanElement | null = null;
let panelEl: HTMLDivElement | null = null;
let menuEl: HTMLDivElement | null = null;
const takenEls = new WeakSet<Element>();

/** Своя песочница стилей: вёрстка сайта не должна ломать прицел, а рамки —
 *  лезть в саму страницу. Хост мышь не ловит, ловит только меню внутри. */
function ui(): ShadowRoot {
  if (shadow) return shadow;
  const host = document.createElement('div');
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    '.frame { position: fixed; border: 2px solid #f5c518; border-radius: 6px;',
    '  box-shadow: 0 0 14px rgba(245, 197, 24, .55); pointer-events: none; }',
    '.frame.taken { border-color: #22c55e; box-shadow: 0 0 14px rgba(34, 197, 94, .5); }',
    '.tag { position: absolute; top: -11px; left: -2px; padding: 1px 6px; border-radius: 5px;',
    '  background: #f5c518; color: #1b1c20; font: 600 11px/1.5 system-ui, sans-serif; white-space: nowrap; }',
    '.frame.taken .tag { background: #22c55e; color: #fff; }',
    '.panel { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px;',
    '  padding: 8px 12px; border-radius: 10px; background: #1b1c20; color: #f2f3f5;',
    '  font: 600 12.5px/1.4 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0, 0, 0, .38); pointer-events: none; }',
    '.panel b { color: #f5c518; }',
    '.panel span { font-weight: 400; opacity: .72; }',
    '.menu { position: fixed; min-width: 168px; padding: 4px; border: 1px solid #e3e4e8;',
    '  border-radius: 10px; background: #fff; box-shadow: 0 8px 28px rgba(20, 20, 25, .18);',
    '  font: 400 13px/1.4 system-ui, sans-serif; pointer-events: auto; }',
    '.menu button { display: block; width: 100%; padding: 6px 10px; border: none; border-radius: 6px;',
    '  background: none; color: #1b1c20; font: inherit; text-align: left; cursor: pointer; }',
    '.menu button:hover { background: #ececef; }',
    '@media (prefers-color-scheme: dark) {',
    '  .menu { background: #262a33; border-color: #363b47; }',
    '  .menu button { color: #f2f3f5; }',
    '  .menu button:hover { background: #313642; }',
    '}',
  ].join('\n');
  shadow.append(style);
  document.documentElement.append(host);
  return shadow;
}

/** Курсор-прицел приходится ставить в саму страницу: из shadow не дотянуться */
let cursorStyle: HTMLStyleElement | null = null;
function setCursor(on: boolean): void {
  if (on && !cursorStyle) {
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = 'html.downy-picking, html.downy-picking * { cursor: crosshair !important; }';
    document.documentElement.append(cursorStyle);
  }
  document.documentElement.classList.toggle('downy-picking', on);
}

function bigEnough(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= MIN_PICK_SIZE && r.height >= MIN_PICK_SIZE;
}

/** Самый крупный доступный адрес картинки: ссылка-обёртка обычно ведёт на
 *  оригинал, srcset несёт размеры, currentSrc — то, что видно на экране. */
function bestImageUrl(img: HTMLImageElement): string | undefined {
  const href = img.closest('a')?.href;
  if (href && IMAGE_FILE.test(href)) return absUrl(href) ?? undefined;

  const best = bestFromSrcset(img.srcset);
  return absUrl(best || img.currentSrc || img.src) ?? undefined;
}

/** Картинка, нарисованная фоном: никакого <img> в DOM нет */
function backgroundUrl(el: Element): string | undefined {
  const bg = getComputedStyle(el).backgroundImage;
  if (!bg || bg === 'none') return undefined;
  const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
  const raw = m?.[2];
  // data: и градиенты качать нечего
  if (!raw || raw.startsWith('data:')) return undefined;
  return absUrl(raw) ?? undefined;
}

function videoTarget(v: HTMLVideoElement): PickTarget {
  const src = v.currentSrc || v.src || '';
  const direct = src.startsWith('blob:') ? null : absUrl(src);
  if (direct) return { el: v, kind: 'video', url: direct };
  // MSE: потока с адресом не существует, зато есть страница поста
  return { el: v, kind: 'video', postUrl: postUrl(v) ?? location.href };
}

/** Что под курсором. Поднимаемся вверх: картинка часто лежит фоном у обёртки */
function pickAt(x: number, y: number): PickTarget | null {
  let node: Element | null = document.elementFromPoint(x, y);
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    if (node instanceof HTMLVideoElement) return videoTarget(node);
    if (node instanceof HTMLImageElement && bigEnough(node)) {
      const url = bestImageUrl(node);
      if (url) return { el: node, kind: 'image', url };
    }
    if (bigEnough(node)) {
      const url = backgroundUrl(node);
      if (url) return { el: node, kind: 'image', url };
    }
  }
  return null;
}

function frameLabel(t: PickTarget): string {
  if (takenEls.has(t.el)) return '✓ уже взято';
  if (t.kind === 'image') return 'картинка';
  return t.url ? 'видео' : 'видео — через yt-dlp';
}

function drawFrame(t: PickTarget | null): void {
  if (!t) {
    frameEl?.remove();
    frameEl = null;
    tagEl = null;
    return;
  }
  const root = ui();
  if (!frameEl) {
    frameEl = document.createElement('div');
    frameEl.className = 'frame';
    tagEl = document.createElement('span');
    tagEl.className = 'tag';
    frameEl.append(tagEl);
    root.append(frameEl);
  }
  const r = t.el.getBoundingClientRect();
  frameEl.classList.toggle('taken', takenEls.has(t.el));
  frameEl.style.left = `${r.left - 2}px`;
  frameEl.style.top = `${r.top - 2}px`;
  frameEl.style.width = `${r.width}px`;
  frameEl.style.height = `${r.height}px`;
  if (tagEl) tagEl.textContent = frameLabel(t);
}

function drawPanel(count: number): void {
  if (!TOP_FRAME) return;
  const root = ui();
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.className = 'panel';
    root.append(panelEl);
  }
  panelEl.textContent = '';
  const title = document.createElement('b');
  title.textContent = count > 0 ? `Downy: ${count}` : 'Downy';
  const hint = document.createElement('span');
  hint.textContent = count > 0 ? 'ESC — закончить' : 'тыкай в медиа, ESC — выход';
  panelEl.append(title, hint);
}

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

/** Меню появляется только там, где есть из чего выбирать — у видео с качествами */
function showMenu(variants: PickVariant[], t: PickTarget, x: number, y: number): void {
  closeMenu();
  const root = ui();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 190))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - 24 - variants.length * 30))}px`;
  for (const v of variants) {
    const btn = document.createElement('button');
    btn.textContent = v.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      void send(t, v.url, v.streams, v.url ? v.label : undefined);
    });
    menuEl.append(btn);
  }
  root.append(menuEl);
}

function markTaken(t: PickTarget): void {
  takenEls.add(t.el);
  if (hovered?.el === t.el) drawFrame(t);
}

async function send(
  t: PickTarget,
  variantUrl?: string,
  streams?: string,
  variantLabel?: string,
): Promise<void> {
  const res = await chrome.runtime.sendMessage({
    type: 'pick',
    kind: t.kind,
    url: t.url,
    postUrl: t.postUrl,
    variantUrl,
    variantLabel,
    streams,
    pageUrl: location.href,
    pageTitle: document.title,
  });
  // Есть из чего выбрать — сначала спрашиваем, качаем вторым заходом
  const variants = res?.variants as PickVariant[] | undefined;
  if (variants?.length) {
    const r = t.el.getBoundingClientRect();
    showMenu(variants, t, r.left + 12, r.top + 12);
    return;
  }
  if (res?.ok) markTaken(t);
}

function setPicker(on: boolean): void {
  if (pickerOn === on) return;
  pickerOn = on;
  setCursor(on);
  closeMenu();
  if (on) {
    drawPanel(0);
  } else {
    drawFrame(null);
    panelEl?.remove();
    panelEl = null;
    hovered = null;
  }
}

function leavePicker(): void {
  setPicker(false);
  void chrome.runtime.sendMessage({ type: 'picker-off' }).catch(() => {});
}

document.addEventListener(
  'mousemove',
  (e) => {
    if (!pickerOn || menuEl) return;
    const t = pickAt(e.clientX, e.clientY);
    // Тот же элемент — рамка уже на месте, лишний раз не дёргаем
    if (t?.el === hovered?.el) return;
    hovered = t;
    drawFrame(t);
  },
  true,
);

document.addEventListener(
  'click',
  (e) => {
    if (!pickerOn) return;
    // Клик по нашему меню — пусть отработает его кнопка
    if (menuEl && e.composedPath().includes(menuEl)) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) {
      closeMenu();
      return;
    }
    const t = pickAt(e.clientX, e.clientY);
    // Клик мимо медиа — выходим: страница должна вернуться к хозяину
    if (!t) {
      leavePicker();
      return;
    }
    hovered = t;
    void send(t);
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (!pickerOn || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    leavePicker();
  },
  true,
);

// Страница уехала под рамкой — рамку надо переставить
for (const event of ['scroll', 'resize'] as const) {
  window.addEventListener(
    event,
    () => {
      if (pickerOn && hovered) drawFrame(hovered);
    },
    true,
  );
}

chrome.runtime.onMessage.addListener((msg: { type?: string; on?: boolean; count?: number }) => {
  if (msg?.type === 'picker') setPicker(!!msg.on);
  else if (msg?.type === 'picker-count' && pickerOn) drawPanel(msg.count ?? 0);
});
