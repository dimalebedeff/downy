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

/** Адреса, по которым узнаётся страница одного ролика, а не лента */
const POST_LINK = /\/(watch\?v=|shorts\/|status\/|reel\/|video\/|videos\/|clip\/|episode\/)/;

/** Постоянная ссылка на пост с видео: yt-dlp не умеет качать /home и главную
 *  ютуба — ему нужен адрес конкретного ролика. Ищем ближайшую к видео ссылку
 *  на пост, поднимаясь от него к карточке-контейнеру. */
function postUrl(v: HTMLElement): string | undefined {
  // Страница сама и есть страница ролика — лучше ссылки не найти
  if (POST_LINK.test(location.href)) return stripSelfHash(location.href);
  let node: HTMLElement | null = v;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    for (const a of node.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const abs = absUrl(a.href);
      if (abs && POST_LINK.test(abs)) return abs;
    }
  }
  return undefined;
}

/** Хэш в адресе ролика — позиция плеера, качать по нему нечего */
function stripSelfHash(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
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
  /** Картинка под тем же курсором: постер плеера, превью ролика в ленте */
  altImageUrl?: string;
}

/** Адреса, которые уедут в загрузку с этой мишени */
function targetKeys(t: PickTarget): string[] {
  return [t.url, t.postUrl, t.altImageUrl].filter((u): u is string => !!u);
}

/** Всё, что можно было взять с этой мишени, уже взято */
function isTaken(t: PickTarget): boolean {
  const keys = targetKeys(t);
  return keys.length > 0 && keys.every((k) => takenKeys.has(k));
}

interface PickVariant {
  label: string;
  url?: string;
  streams?: string;
  /** Вариант может увести на другой тип: с обложки — на сам ролик */
  kind?: 'image' | 'video';
}

interface SendOpts {
  url?: string;
  variantUrl?: string;
  variantLabel?: string;
  streams?: string;
  kind?: 'image' | 'video';
  /** Человек выбрал в меню — второй раз спрашивать нечего */
  chosen?: boolean;
}


/** Событие прицела в общий coapp.log — через фон, своего порта у страницы нет */
function log(message: string): void {
  void chrome.runtime.sendMessage({ type: 'log', source: 'page', message }).catch(() => {});
}

let pickerOn = false;
let hovered: PickTarget | null = null;
let shadow: ShadowRoot | null = null;
let frameEl: HTMLDivElement | null = null;
let tagEl: HTMLSpanElement | null = null;
let panelEl: HTMLDivElement | null = null;
let menuEl: HTMLDivElement | null = null;
/** Взятое помним по адресу, а не по элементу: на главной ютуба один и тот же
 *  <video> переезжает от превью к превью, и по элементу все ролики после
 *  первого выглядели бы уже скачанными. */
const takenKeys = new Set<string>();

/** Своя песочница стилей: вёрстка сайта не должна ломать прицел, а рамки —
 *  лезть в саму страницу. Хост мышь не ловит, ловит только меню внутри. */
function ui(): ShadowRoot {
  if (shadow) return shadow;
  const host = document.createElement('div');
  host.style.cssText =
    "all: initial; font-family: 'Downy Golos', system-ui, 'Segoe UI', sans-serif;" +
    ' position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  const cyrillic = chrome.runtime.getURL('fonts/golos-cyrillic.woff2');
  const latin = chrome.runtime.getURL('fonts/golos-latin.woff2');
  // Golos Text вшит в расширение (тот же шрифт, что в попапе — интернет не нужен),
  // но объявлять его приходится в самом документе: @font-face внутри shadow root
  // Chrome не применяет, и всё внутри оставалось на системном шрифте
  const face = document.createElement('style');
  face.textContent = [
    "@font-face { font-family: 'Downy Golos'; font-weight: 400 900; font-display: swap;",
    `  src: url('${cyrillic}') format('woff2');`,
    '  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }',
    "@font-face { font-family: 'Downy Golos'; font-weight: 400 900; font-display: swap;",
    `  src: url('${latin}') format('woff2');`,
    '  unicode-range: U+0000-00FF, U+2000-206F, U+2212, U+FEFF, U+FFFD; }',
  ].join('\n');
  (document.head ?? document.documentElement).append(face);

  style.textContent = [
    '.frame { position: fixed; border: 2px solid #f5c518; border-radius: 6px;',
    '  box-shadow: 0 0 14px rgba(245, 197, 24, .55); pointer-events: none; }',
    '.frame.taken { border-color: #22c55e; box-shadow: 0 0 14px rgba(34, 197, 94, .5); }',
    '.tag { position: absolute; top: -11px; left: -2px; padding: 1px 6px; border-radius: 5px;',
    "  background: #f5c518; color: #1b1c20; font: 600 11px/1.5 'Downy Golos', system-ui, sans-serif; white-space: nowrap; }",
    '.frame.taken .tag { background: #22c55e; color: #fff; }',
    '.panel { display: flex; align-items: center; gap: 8px;',
    '  padding: 8px 12px; border-radius: 10px; background: #1b1c20; color: #f2f3f5;',
    "  font: 600 12.5px/1.4 'Downy Golos', system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0, 0, 0, .38); pointer-events: none; }",
    '.panel b { color: #f5c518; }',
    '.panel span { font-weight: 400; opacity: .72; }',
    '.menu { position: fixed; min-width: 168px; padding: 4px; border: 1px solid #e3e4e8;',
    '  border-radius: 10px; background: #fff; box-shadow: 0 8px 28px rgba(20, 20, 25, .18);',
    "  font: 400 13px/1.4 'Downy Golos', system-ui, sans-serif; pointer-events: auto; }",
    '.menu button { display: block; width: 100%; padding: 6px 10px; border: none; border-radius: 6px;',
    '  background: none; color: #1b1c20; font: inherit; text-align: left; cursor: pointer; }',
    '.menu button:hover { background: #ececef; }',
    '@media (prefers-color-scheme: dark) {',
    '  .menu { background: #262a33; border-color: #363b47; }',
    '  .menu button { color: #f2f3f5; }',
    '  .menu button:hover { background: #313642; }',
    '}',
    /* Уголок: сверху тосты загрузок, снизу плашка прицела */
    '.corner { position: fixed; right: 14px; bottom: 14px; display: flex; flex-direction: column;',
    '  align-items: flex-end; gap: 8px; pointer-events: none; max-width: 320px; }',
    '.tt { min-width: 226px; max-width: 300px; border-radius: 12px; overflow: hidden;',
    "  font-family: 'Downy Golos', system-ui, 'Segoe UI', sans-serif;",
    '  background: #fff; color: #1b1c20; border: 1px solid #e3e4e8;',
    '  box-shadow: 0 6px 22px rgba(15, 17, 22, .2);',
    '  animation: ttIn .2s cubic-bezier(.2, .8, .3, 1) both; }',
    '.tt.out { animation: ttOut .2s ease forwards; }',
    '@keyframes ttIn { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }',
    '@keyframes ttOut { to { opacity: 0; transform: translateY(4px) scale(.98); } }',
    '.tt-row { display: flex; align-items: center; gap: 8px; padding: 8px 11px; }',
    '.tt-icon { flex: none; font-size: 12px; color: #94740a; }',
    '.tt-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 600;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.tt-state { flex: none; font-size: 11px; color: #6e7278; font-variant-numeric: tabular-nums; }',
    '.tt-state.ok { color: #94740a; font-weight: 700; }',
    '.tt-state.err { color: #dc2626; font-weight: 700; }',
    '.tt-spin { flex: none; width: 12px; height: 12px; border-radius: 50%;',
    '  border: 2px solid #ececef; border-top-color: #f5c518; animation: spin .7s linear infinite; }',
    '.tt-bar { height: 3px; background: #ececef; }',
    '.tt-fill { height: 100%; width: 0; background: #f5c518; box-shadow: 0 0 8px rgba(245, 197, 24, .5);',
    '  transition: width .25s linear; }',
    '.tt-fill.idle { width: 35%; animation: ttSlide 1.4s ease-in-out infinite alternate; }',
    '@keyframes ttSlide { from { margin-left: 0; } to { margin-left: 65%; } }',
    '@media (prefers-color-scheme: dark) {',
    '  .tt { background: #262a33; color: #f2f3f5; border-color: #363b47; }',
    '  .tt-state { color: #a3a9b4; }',
    '  .tt-state.ok, .tt-icon { color: #f5c518; }',
    '  .tt-bar { background: #313642; }',
    '  .tt-spin { border-color: #313642; border-top-color: #f5c518; }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  .tt, .tt.out { animation: none; }',
    '  .tt-spin, .tt-fill.idle { animation: none; }',
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

/** Курсор реально стоит на этом элементе, даже если сверху лежит чужой слой */
function hits(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Цепочка от точки вверх: сам элемент под курсором и его предки */
function chainAt(x: number, y: number): Element[] {
  const chain: Element[] = [];
  let node: Element | null = document.elementFromPoint(x, y);
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) chain.push(node);
  return chain;
}

/** Видео ищем первым проходом по всей цепочке. Плееры кладут поверх ролика
 *  постер и слой-ловушку кликов, поэтому одного elementFromPoint мало: на
 *  каждом уровне заглядываем внутрь и берём видео, на котором стоит курсор. */
function videoAt(x: number, y: number): PickTarget | null {
  for (const node of chainAt(x, y)) {
    if (node instanceof HTMLVideoElement) return videoTarget(node);
    for (const inner of node.querySelectorAll('video')) {
      if (hits(inner, x, y)) return videoTarget(inner);
    }
  }
  return null;
}

function imageAt(x: number, y: number): PickTarget | null {
  for (const node of chainAt(x, y)) {
    if (node instanceof HTMLImageElement && bigEnough(node)) {
      const url = bestImageUrl(node);
      if (url) return imageTarget(node, url);
    }
    for (const inner of node.querySelectorAll('img')) {
      if (!hits(inner, x, y) || !bigEnough(inner)) continue;
      const url = bestImageUrl(inner);
      if (url) return imageTarget(inner, url);
    }
    if (bigEnough(node)) {
      const url = backgroundUrl(node);
      if (url) return imageTarget(node, url);
    }
  }
  return null;
}

/** Превью ролика — тоже картинка, но за ней обычно стоит ссылка на страницу
 *  ролика. Держим её при себе: спросим, что человек имел в виду. */
function imageTarget(el: Element, url: string): PickTarget {
  const href = el.closest('a')?.href;
  const post = href ? absUrl(href) : null;
  return {
    el,
    kind: 'image',
    url,
    postUrl: post && POST_LINK.test(post) ? post : undefined,
  };
}

/** Видео важнее картинки, но постер плеера и превью в ленте — тоже добыча.
 *  Нашли под курсором оба — не решаем за человека, показываем выбор. */
function pickAt(x: number, y: number): PickTarget | null {
  const video = videoAt(x, y);
  const image = imageAt(x, y);
  if (!video) return image;
  return image?.url ? { ...video, altImageUrl: image.url } : video;
}

function frameLabel(t: PickTarget): string {
  if (isTaken(t)) return '✓ уже взято';
  if (t.kind === 'image') {
    // Настоящий размер файла, а не растянутый на экране: сразу видно, что
    // под курсором мелкая обложка, а не полноразмерный снимок
    const img = t.el instanceof HTMLImageElement ? t.el : null;
    const size = img?.naturalWidth ? ` ${img.naturalWidth}×${img.naturalHeight}` : '';
    return t.postUrl ? `картинка${size} — или ролик` : `картинка${size}`;
  }
  const via = t.url ? 'видео' : 'видео — yt-dlp, до 1080p';
  return t.altImageUrl ? `${via} — или картинка` : via;
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
  frameEl.classList.toggle('taken', isTaken(t));
  frameEl.style.left = `${r.left - 2}px`;
  frameEl.style.top = `${r.top - 2}px`;
  frameEl.style.width = `${r.width}px`;
  frameEl.style.height = `${r.height}px`;
  if (tagEl) tagEl.textContent = frameLabel(t);
}

function drawPanel(count: number): void {
  if (!TOP_FRAME) return;
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.className = 'panel';
    // Всегда нижняя строка уголка: тосты копятся над ней
    cornerBox().append(panelEl);
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

/** Меню у курсора. Появляется только там, где есть из чего выбирать */
function openMenu(x: number, y: number, items: { label: string; run: () => void }[]): void {
  closeMenu();
  const root = ui();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - 190))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - 24 - items.length * 30))}px`;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      log(`выбрали в меню: ${item.label}`);
      item.run();
    });
    menuEl.append(btn);
  }
  root.append(menuEl);
  log(`меню: ${items.map((i) => i.label).join(' / ')}`);
}

/** Качества видео — их присылает фон, когда вариантов больше одного */
function showMenu(variants: PickVariant[], t: PickTarget, x: number, y: number): void {
  openMenu(
    x,
    y,
    variants.map((v) => ({
      label: v.label,
      run: () =>
        void send(t, {
          // Вариант с собственным типом ведёт на другой файл (ролик вместо
          // обложки), качества же уточняют ту же загрузку
          ...(v.kind ? { kind: v.kind, url: v.url } : { variantUrl: v.url, variantLabel: v.url ? v.label : undefined }),
          streams: v.streams,
          chosen: true,
        }),
    })),
  );
}

/** Под курсором и ролик, и картинка — спрашиваем, что именно нужно.
 *  Случая два: превью со ссылкой на страницу ролика и плеер со своим постером. */
function showChoice(t: PickTarget, x: number, y: number): void {
  const videoTgt: PickTarget =
    t.kind === 'video' ? { ...t, altImageUrl: undefined } : { el: t.el, kind: 'video', postUrl: t.postUrl };
  const imageUrl = t.kind === 'video' ? t.altImageUrl : t.url;
  openMenu(x, y, [
    { label: 'Скачать ролик', run: () => void send(videoTgt, { chosen: true }) },
    {
      label: 'Скачать картинку',
      run: () => void send({ el: t.el, kind: 'image', url: imageUrl }, { chosen: true }),
    },
  ]);
}

function markTaken(key: string | undefined): void {
  if (key) takenKeys.add(key);
  if (hovered) drawFrame(hovered);
}

async function send(t: PickTarget, opts: SendOpts = {}): Promise<void> {
  const sentUrl = opts.url ?? t.url;
  const res = await chrome.runtime.sendMessage({
    type: 'pick',
    kind: opts.kind ?? t.kind,
    url: opts.url ?? t.url,
    postUrl: t.postUrl,
    variantUrl: opts.variantUrl,
    variantLabel: opts.variantLabel,
    streams: opts.streams,
    chosen: opts.chosen,
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
  if (res?.ok) markTaken(sentUrl ?? t.postUrl);
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

// Поиск мишени лазает по DOM — на каждый пиксель движения это слишком дорого
let moveScheduled = false;
document.addEventListener(
  'mousemove',
  (e) => {
    if (!pickerOn || menuEl || moveScheduled) return;
    moveScheduled = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      moveScheduled = false;
      if (!pickerOn || menuEl) return;
      const t = pickAt(clientX, clientY);
      // Тот же элемент — рамка уже на месте, лишний раз не дёргаем
      if (t?.el === hovered?.el) return;
      hovered = t;
      drawFrame(t);
    });
  },
  true,
);

document.addEventListener(
  'click',
  (e) => {
    if (!pickerOn) return;
    // Клик по нашему меню — пусть отработает его кнопка. Судим по координатам:
    // shadow root закрытый, и composedPath() снаружи меню не показывает
    if (menuEl && hits(menuEl, e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) {
      closeMenu();
      return;
    }
    const t = pickAt(e.clientX, e.clientY);
    // Клик мимо медиа — выходим: страница должна вернуться к хозяину
    if (!t) {
      log('клик мимо медиа — выходим из прицела');
      leavePicker();
      return;
    }
    hovered = t;
    // Под курсором и ролик, и картинка — угадывать за человека нечего
    if ((t.kind === 'image' && t.postUrl) || (t.kind === 'video' && t.altImageUrl)) {
      showChoice(t, e.clientX, e.clientY);
      return;
    }
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

chrome.runtime.onMessage.addListener(
  (msg: { type?: string; on?: boolean; count?: number; jobs?: PageJob[] }) => {
    if (msg?.type === 'picker') setPicker(!!msg.on);
    else if (msg?.type === 'picker-count' && pickerOn) drawPanel(msg.count ?? 0);
    // Тосты живут и после выхода из прицела: загрузка идёт своим ходом
    else if (msg?.type === 'page-jobs' && TOP_FRAME) {
      for (const job of msg.jobs ?? []) updateToast(job);
    }
  },
);

// ---------- Тосты: что происходит с загрузкой, начатой со страницы ----------
//
// Попап в этот момент закрыт, и без тоста клик прицелом выглядит так, будто
// ничего не произошло. Короткая загрузка успевает только объявить о старте:
// держать «готово» на экране ради картинки на два мегабайта незачем.

/** Дольше этого — результат стоит показать: человек уже забыл, что качал */
const TOAST_LONG_MS = 10_000;
/** Больше не помещается по-человечески: старые завершённые уступают место */
const TOAST_MAX = 4;

interface Toast {
  node: HTMLDivElement;
  state: HTMLSpanElement;
  bar: HTMLDivElement;
  fill: HTMLDivElement;
  spin: HTMLSpanElement;
  startedAt: number;
  finished: boolean;
}

const toasts = new Map<string, Toast>();

function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2).replace('.', ',')} ГБ`;
  if (mb >= 10) return `${Math.round(mb)} МБ`;
  return `${mb.toFixed(1).replace('.', ',')} МБ`;
}

function cornerBox(): HTMLDivElement {
  const root = ui();
  let box = root.querySelector<HTMLDivElement>('.corner');
  if (!box) {
    box = document.createElement('div');
    box.className = 'corner';
    root.append(box);
  }
  return box;
}

function toastIcon(kind?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'tt-icon';
  span.textContent = kind === 'image' ? '🖼' : kind === 'audio' ? '♪' : '▶';
  return span;
}

function makeToast(job: PageJob): Toast {
  const node = document.createElement('div');
  node.className = 'tt';

  const row = document.createElement('div');
  row.className = 'tt-row';

  const name = document.createElement('span');
  name.className = 'tt-name';
  name.textContent = job.label;
  name.title = job.label;

  const spin = document.createElement('span');
  spin.className = 'tt-spin';

  const state = document.createElement('span');
  state.className = 'tt-state';
  state.textContent = 'запускаю';

  row.append(toastIcon(job.mediaKind), name, spin, state);

  const bar = document.createElement('div');
  bar.className = 'tt-bar';
  const fill = document.createElement('div');
  fill.className = 'tt-fill';
  bar.append(fill);

  node.append(row, bar);
  // Свежий тост сверху стопки, плашка прицела всегда остаётся внизу
  const box = cornerBox();
  box.insertBefore(node, box.firstChild);

  return { node, state, bar, fill, spin, startedAt: Date.now(), finished: false };
}

function dropToast(jobId: string, after: number): void {
  const t = toasts.get(jobId);
  if (!t) return;
  window.setTimeout(() => {
    t.node.classList.add('out');
    window.setTimeout(() => {
      t.node.remove();
      toasts.delete(jobId);
    }, 200);
  }, after);
}

/** Стопка не должна расти бесконечно: пачку в двадцать картинок не прочесть */
function trimToasts(): void {
  const done = [...toasts.entries()].filter(([, t]) => t.finished);
  while (toasts.size > TOAST_MAX && done.length > 0) {
    const [id, t] = done.shift()!;
    t.node.remove();
    toasts.delete(id);
  }
}

function updateToast(job: PageJob): void {
  if (job.state === 'canceled') {
    const t = toasts.get(job.jobId);
    if (t) {
      t.node.remove();
      toasts.delete(job.jobId);
    }
    return;
  }

  let t = toasts.get(job.jobId);
  if (!t) {
    t = makeToast(job);
    toasts.set(job.jobId, t);
    trimToasts();
  }
  if (t.finished) return;

  if (job.state === 'queued') {
    t.state.textContent = 'в очереди';
    return;
  }

  if (job.state === 'running' || job.state === 'starting') {
    t.spin.remove();
    const ratio = job.progress ?? (job.totalBytes ? (job.bytes ?? 0) / job.totalBytes : null);
    if (ratio != null) {
      t.fill.style.width = `${Math.round(ratio * 100)}%`;
      t.state.textContent = `${Math.round(ratio * 100)}%`;
    } else {
      t.fill.classList.add('idle');
      t.state.textContent = fmtBytes(job.bytes) || 'качаю';
    }
    return;
  }

  // Готово или ошибка — дальше тост только уезжает
  t.finished = true;
  t.spin.remove();
  t.bar.remove();
  const quick = Date.now() - t.startedAt < TOAST_LONG_MS;
  if (job.state === 'done') {
    t.state.className = 'tt-state ok';
    t.state.textContent = `✓ ${fmtBytes(job.bytes) || 'готово'}`;
    // Быстрая загрузка сама себе уведомление о старте: показали и убрали
    dropToast(job.jobId, quick ? 900 : 4500);
  } else {
    t.state.className = 'tt-state err';
    t.state.textContent = 'ошибка';
    t.node.title = job.message ?? '';
    dropToast(job.jobId, 6000);
  }
}

interface PageJob {
  jobId: string;
  label: string;
  state: string;
  progress: number | null;
  bytes?: number;
  totalBytes?: number;
  mediaKind?: string;
  message?: string;
}
