// Две работы: пассивно ловит медиа из DOM (теги video/audio/source) вместе с
// превью — poster, кадр из играющего видео, обложка страницы; и держит прицел,
// которым медиа выбирают кликом прямо на странице.
// Стримы через MSE (blob:) в первую часть не попадают — их видит background
// по сети, а прицел отдаёт такие ролики yt-dlp по адресу поста.

import { backgroundImageUrl, bestFromSrcset, isPostLink, meetsPickThreshold } from './lib/pick';
import { unsupportedReason } from './lib/unsupported';
import { fmtEta, fmtSize, fmtSpeed } from './lib/progress';
import { pausedLabel } from './lib/queue';
import { typeIconSvg, type FileKind } from './lib/media-icon';

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

/** Карточка поста в ленте: у X это article, у остальных — свои приметы */
const POST_CARD = 'article, [role="article"], [data-testid="tweet"], [data-testid="cellInnerDiv"]';

/** Ссылка на пост внутри узла — ближайшая к видео */
function postLinkIn(node: Element): string | undefined {
  for (const a of node.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const abs = absUrl(a.href);
    if (abs && isPostLink(abs)) return abs;
  }
  return undefined;
}

/** Постоянная ссылка на пост с видео: yt-dlp не умеет качать /home и главную
 *  ютуба — ему нужен адрес конкретного ролика. */
function postUrl(v: HTMLElement): string | undefined {
  // Страница сама и есть страница ролика — лучше ссылки не найти
  if (isPostLink(location.href)) return stripSelfHash(location.href);

  // Карточка поста целиком: в ленте X от видео до неё полтора десятка узлов,
  // и подъём по одному уровню за раз до ссылки не доходил
  const card = v.closest(POST_CARD);
  if (card) {
    const inCard = postLinkIn(card);
    if (inCard) return inCard;
  }

  // Разметка незнакомая — поднимаемся сами, но заметно выше прежнего
  let node: HTMLElement | null = v;
  for (let depth = 0; node && depth < 16; depth++, node = node.parentElement) {
    const found = postLinkIn(node);
    if (found) return found;
  }
  return undefined;
}

/** Похоже на ленту: роликов много, и адрес страницы ни одному из них не адрес */
function looksLikeFeed(): boolean {
  return document.querySelectorAll('video').length > 1 && !isPostLink(location.href);
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
  /** Ради качеств готовы подождать разведку — так просит правый клик */
  wantVariants?: boolean;
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
    ':host, .corner, .menu, .panel, .frame { box-sizing: border-box; }',
    '.menu *, .panel *, .corner * { box-sizing: border-box; }',
    '.frame { position: fixed; border: 2px solid #f5c518; border-radius: 6px;',
    '  box-shadow: 0 0 14px rgba(245, 197, 24, .55); pointer-events: none; }',
    '.p-note { padding: 6px 9px; font-size: 11px; line-height: 1.4; opacity: .72; max-width: 240px; }',
    '.frame.taken { border-color: #22c55e; box-shadow: 0 0 14px rgba(34, 197, 94, .5); }',
    '.tag { position: absolute; top: -11px; left: -2px; padding: 1px 6px; border-radius: 5px;',
    "  background: #f5c518; color: #1b1c20; font: 600 11px/1.5 'Downy Golos', system-ui, sans-serif; white-space: nowrap; }",
    '.frame.taken .tag { background: #22c55e; color: #fff; }',
    '.menu { position: fixed; min-width: 168px; max-width: 320px; overflow: hidden;',
    '  padding: 4px; border: 1px solid #363b47;',
    '  border-radius: 10px; background: #262a33; box-shadow: 0 8px 28px rgba(0, 0, 0, .5);',
    "  font: 400 13px/1.4 'Downy Golos', system-ui, sans-serif; pointer-events: auto; }",
    /* Пункт с двумя зонами: слева действие, справа — что именно скачается */
    /* Ширину просит сама строка: меню с одним «Пробив…» должно быть узким */
    '.split { display: flex; align-items: stretch; border-radius: 6px; overflow: hidden; min-width: 210px; }',
    '.split:hover { background: #313642; }',
    '.split .main { flex: 1 1 auto; width: auto; min-width: 0; padding: 6px 10px; border: none; background: none;',
    '  font: inherit; text-align: left; cursor: pointer; color: #f2f3f5;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.split .more { flex: 0 0 auto; width: auto; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;',
    '  padding: 0 8px; border: none; border-left: 1px solid #414857; background: #2f3540;',
    "  color: #f2f3f5; font: 600 11px/1 'Downy Golos', system-ui, sans-serif; cursor: pointer; }",
    '.split .more:hover { background: #f5c518; color: #1b1c20; }',
    '.split .more svg { display: block; }',
    /* Пробив идёт: значение временное, поэтому бледное, а на месте шеврона
       крутится кольцо — ширина зоны при этом почти как у готового «1080p» */
    '.split .more.pending { color: #8b9099; }',
    '.more-ring { display: inline-block; width: 11px; height: 11px; border-radius: 50%;',
    '  border: 2px solid #414857; border-top-color: #f5c518; animation: spin .7s linear infinite; }',
    '.split .more.ready { animation: zoneReady .5s ease; }',
    '@keyframes zoneReady { 0% { background: #f5c518; color: #1b1c20; } 100% { background: #2f3540; } }',
    '.menu > button { display: block; width: 100%; padding: 6px 10px; border: none; border-radius: 6px;',
    '  background: none; color: #f2f3f5; font: inherit; text-align: left; cursor: pointer; }',
    '.menu > button:hover { background: #313642; }',
    '.menu > .busy { display: flex; align-items: center; gap: 7px; color: #a3a9b4; cursor: default; }',
    '.menu > .busy:hover { background: none; }',
    '.busy-spin { flex: none; width: 12px; height: 12px; border-radius: 50%;',
    '  border: 2px solid #313642; border-top-color: #f5c518; animation: spin .7s linear infinite; }',
    /* Уголок: панель Downy — один объект вместо россыпи карточек */
    '.corner { position: fixed; right: 14px; bottom: 14px; display: flex; flex-direction: column;',
    '  align-items: stretch; gap: 8px; width: 296px; max-width: calc(100vw - 28px); }',
    '.panel { pointer-events: auto; border-radius: 12px; overflow: hidden;',
    '  background: #262a33; color: #f2f3f5; border: 1px solid #363b47;',
    '  box-shadow: 0 6px 22px rgba(0, 0, 0, .5);',
    '  animation: ttIn .2s cubic-bezier(.2, .8, .3, 1) both; }',
    '.panel.out { animation: ttOut .2s ease forwards; }',
    '@keyframes ttIn { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }',
    '@keyframes ttOut { to { opacity: 0; transform: translateY(4px) scale(.98); } }',
    '.p-head { display: flex; align-items: center; gap: 8px; padding: 7px 11px;',
    '  border-bottom: 1px solid #363b47; font-size: 12.5px; font-weight: 700; }',
    '.p-hint { flex: 1; font-size: 10.5px; font-weight: 400; color: #a3a9b4; }',
    '.p-count { flex: none; background: #f5c518; color: #1b1c20; border-radius: 20px;',
    '  padding: 1px 8px; font-size: 10.5px; font-weight: 700; }',
    '.p-count[hidden] { display: none; }',
    '.p-item + .p-item { border-top: 1px solid #363b47; }',
    '.p-line { display: flex; align-items: center; gap: 8px; padding: 8px 11px 5px; }',
    '.p-icon { flex: none; display: inline-flex; align-items: center; color: #f5c518; }',
    '.p-icon svg { display: block; }',
    '.p-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 600;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.p-state { flex: none; font-size: 11px; color: #a3a9b4; font-variant-numeric: tabular-nums; }',
    '.p-state.ok { color: #f5c518; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; }',
    '.p-state.err { color: #dc2626; font-weight: 700; }',
    '.p-spin { flex: none; width: 12px; height: 12px; border-radius: 50%;',
    '  border: 2px solid #313642; border-top-color: #f5c518; animation: spin .7s linear infinite; }',
    '.p-spin[hidden] { display: none; }',
    '@keyframes spin { to { transform: rotate(360deg); } }',
    /* Крестик держит своё место всегда — иначе строка дёргалась бы на ховере */
    '.p-cancel { flex: none; width: 16px; height: 16px; padding: 0; border: none; border-radius: 5px;',
    '  background: none; color: #a3a9b4; cursor: pointer; opacity: 0; transition: opacity .12s ease;',
    '  display: inline-flex; align-items: center; justify-content: center; }',
    '.p-cancel svg { display: block; }',
    '.p-item:hover .p-cancel { opacity: 1; }',
    '.p-cancel:hover { background: #313642; color: #dc2626; }',
    /* Метрики и полоса заведены сразу: высота строки не меняется по ходу */
    '.p-meta { min-height: 13px; padding: 0 11px 6px; font-size: 10.5px; color: #a3a9b4;',
    '  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.p-bar { height: 3px; background: #313642; }',
    '.p-fill { height: 100%; width: 0; background: #f5c518;',
    '  box-shadow: 0 0 8px rgba(245, 197, 24, .5); transition: width .25s linear; }',
    '.p-foot { padding: 6px 11px; border-top: 1px solid #363b47; font-size: 10.5px; color: #a3a9b4; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .panel, .panel.out { animation: none; }',
    '  .p-spin { animation: none; }',
    '  .p-fill { transition: none; }',
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

/** Зажатый Alt снимает порог: иногда нужна именно мелочь — значок, стикер,
 *  крошечная анимация. Порог существует, чтобы прицел не цеплялся за иконки
 *  интерфейса, поэтому снимаем его только пока клавиша нажата. */
let greedy = false;

/** Прошёл бы элемент прицел без всякого Alt */
function meetsThreshold(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return meetsPickThreshold(r.width, r.height);
}

function bigEnough(el: Element): boolean {
  return greedy || meetsThreshold(el);
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
  const raw = backgroundImageUrl(getComputedStyle(el));
  return raw ? (absUrl(raw) ?? undefined) : undefined;
}

function videoTarget(v: HTMLVideoElement): PickTarget {
  const src = v.currentSrc || v.src || '';
  const direct = src.startsWith('blob:') ? null : absUrl(src);
  if (direct) return { el: v, kind: 'video', url: direct };
  // MSE: потока с адресом не существует, зато есть страница поста. В ленте
  // адрес самой страницы подсовывать нечестно — yt-dlp по /home ничего не
  // найдёт и загрузка отвалится ошибкой
  const post = postUrl(v);
  return { el: v, kind: 'video', postUrl: post ?? (looksLikeFeed() ? undefined : location.href) };
}

/** Курсор над нашим же интерфейсом: меню выбора или панель загрузок.
 *  Судим по координатам — shadow root закрытый, composedPath снаружи пуст */
function overOwnUi(x: number, y: number): boolean {
  return (menuEl != null && hits(menuEl, x, y)) || (panelEl != null && hits(panelEl, x, y));
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

/** Настоящий <img> ищем по всей цепочке первым проходом, фон — вторым. Сайты
 *  кладут поверх картинки прозрачный слой-заглушку с фоновым узором, и один
 *  общий проход отдавал эту заглушку: она ближе к курсору, чем сама картинка. */
function imageAt(x: number, y: number): PickTarget | null {
  const chain = chainAt(x, y);
  for (const node of chain) {
    if (node instanceof HTMLImageElement && bigEnough(node)) {
      const url = bestImageUrl(node);
      if (url) return imageTarget(node, url);
    }
    for (const inner of node.querySelectorAll('img')) {
      if (!hits(inner, x, y) || !bigEnough(inner)) continue;
      const url = bestImageUrl(inner);
      if (url) return imageTarget(inner, url);
    }
  }
  for (const node of chain) {
    if (!bigEnough(node)) continue;
    const url = backgroundUrl(node);
    if (url) return imageTarget(node, url);
  }
  return null;
}

/** Превью ролика — тоже картинка, но за ней обычно стоит ссылка на страницу
 *  ролика. Держим её при себе: спросим, что человек имел в виду. */
function imageTarget(el: Element, url: string): PickTarget {
  const href = el.closest('a')?.href;
  const post = href ? absUrl(href) : null;
  let offerVideo = post != null && isPostLink(post);
  // В ленте X ссылка на пост висит на каждой картинке, включая фотопосты без
  // единого ролика. Раз карточка поста опознана — спрашиваем её саму, есть ли
  // там видео, и не предлагаем скачать то, чего в посте нет
  const card = el.closest(POST_CARD);
  if (offerVideo && card) offerVideo = card.querySelector('video') != null;
  return { el, kind: 'image', url, postUrl: offerVideo ? (post ?? undefined) : undefined };
}

/** Видео важнее картинки, но постер плеера и превью в ленте — тоже добыча.
 *  Нашли под курсором оба — не решаем за человека, показываем выбор. */
function pickAt(x: number, y: number): PickTarget | null {
  const video = videoAt(x, y);
  const image = imageAt(x, y);
  if (!video) return image;
  return image?.url ? { ...video, altImageUrl: image.url } : video;
}

/** Размер в подписи прицела. У <img> берём настоящий размер файла, а не
 *  растянутый на экране: сразу видно, мелкая под курсором обложка или
 *  полноразмерный снимок. Фон и svg своего размера не называют — там говорим
 *  экранный: цифры рядом с «мелочью» нужнее, чем пустота. */
function pickSize(el: Element): string {
  if (el instanceof HTMLImageElement && el.naturalWidth) {
    return ` ${el.naturalWidth}×${el.naturalHeight}`;
  }
  const r = el.getBoundingClientRect();
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  return w && h ? ` ${w}×${h}` : '';
}

function frameLabel(t: PickTarget): string {
  // Пометка ставится в момент старта, а не завершения: файл может ещё качаться,
  // поэтому говорим про список загрузок, а не про «скачано»
  if (isTaken(t)) return 'в загрузках';
  if (t.kind === 'image') {
    const size = pickSize(t.el);
    if (t.postUrl) return `картинка${size} — или видео`;
    // «Мелочь» — приговор размеру, а не зажатой клавише: под Alt в прицел
    // попадает и крупная картинка, и звать её мелочью — врать человеку
    return meetsThreshold(t.el) ? `картинка${size}` : `мелочь${size}`;
  }
  // Ленты бывают такие, что пост у видео не опознать — честнее сказать заранее
  if (!t.url && !t.postUrl) return 'не понять, из какого поста видео';
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

function closeMenu(): void {
  window.clearInterval(busyTimer);
  window.clearInterval(asidePoll);
  busyTimer = 0;
  asidePoll = 0;
  menuEl?.remove();
  menuEl = null;
}

/** Меню у курсора. Появляется только там, где есть из чего выбирать */
const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
  '<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.6"' +
  ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

let lastMenuAt = { x: 0, y: 0 };

interface MenuItem {
  label: string;
  run: () => void;
  /** Вторая зона справа: подпись (какое качество возьмём) и своё действие */
  aside?: { hint: string; run: () => void };
  /** Ждём разведку: пункт не нажимается, при нём крутится спиннер */
  busy?: boolean;
  /** Просто сообщение: не нажимается, но и крутиться нечему */
  note?: boolean;
}

/** Правая зона пункта, если она есть — иначе обычная строка меню */
function menuRow(item: MenuItem): HTMLElement {
  const fire = (label: string, run: () => void) => {
    closeMenu();
    log(`выбрали в меню: ${label}`);
    run();
  };

  if (item.busy || item.note) {
    const btn = document.createElement('button');
    btn.className = 'busy';
    btn.disabled = true;
    if (item.busy) {
      const spin = document.createElement('span');
      spin.className = 'busy-spin';
      btn.append(spin);
    }
    const text = document.createElement('span');
    text.textContent = item.label;
    btn.append(text);
    return btn;
  }

  if (!item.aside) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      fire(item.label, item.run);
    });
    return btn;
  }

  const row = document.createElement('div');
  row.className = 'split';
  const main = document.createElement('button');
  main.className = 'main';
  main.textContent = item.label;
  main.addEventListener('click', (e) => {
    e.stopPropagation();
    fire(item.label, item.run);
  });
  const more = document.createElement('button');
  more.className = 'more';
  more.title = 'Ищу качества';
  more.append(item.aside.hint);
  more.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    fire(`${item.label} → выбор качества`, item.aside!.run);
  });
  row.append(main, more);
  return row;
}

function openMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  lastMenuAt = { x, y };
  const root = ui();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  for (const item of items) menuEl.append(menuRow(item));
  root.append(menuEl);
  // Размер известен только после вставки — по нему и держим меню в экране
  const box = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 8))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 8))}px`;
  log(`меню: ${items.map((i) => i.label).join(' / ')}`);
}

let busyTimer = 0;

/** Ожидание разведки. Слово и бегущие точки — те же, что в попапе: там это
 *  состояние уже называется «Пробив», и двух названий у него быть не должно. */
function showBusy(): void {
  openMenu(lastMenuAt.x, lastMenuAt.y, [{ label: 'Пробив', run: () => undefined, busy: true }]);
  let dots = 0;
  busyTimer = window.setInterval(() => {
    dots = (dots + 1) % 4;
    const el = menuEl?.querySelector('.busy span:last-child');
    if (el) el.textContent = `Пробив${'.'.repeat(dots)}`;
  }, 400);
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
    { label: 'Скачать видео', run: () => void send(videoTgt, { chosen: true }) },
    {
      label: 'Скачать картинку',
      run: () => void send({ el: t.el, kind: 'image', url: imageUrl }, { chosen: true }),
    },
  ]);
}

/** Превью ролика: постер самого плеера, а если его нет — картинка рядом */
function posterOf(t: PickTarget): string | undefined {
  const video =
    t.el instanceof HTMLVideoElement ? t.el : t.el.closest(POST_CARD)?.querySelector('video');
  const poster = video?.getAttribute('poster');
  const abs = poster ? absUrl(poster) : null;
  return abs ?? t.altImageUrl;
}

/**
 * Правый клик в прицеле: всё, что можно взять с этого элемента. Левый клик
 * решает за человека и спрашивает, только когда выбор неизбежен, — а здесь
 * человек сам попросил показать варианты, включая превью, до которого иначе
 * не добраться: под курсором всегда выигрывает видео.
 */
function showAllOptions(t: PickTarget, x: number, y: number): void {
  const items: MenuItem[] = [];

  if (t.kind === 'video') {
    const video: PickTarget = { ...t, altImageUrl: undefined };
    // Основная зона качает немедленно, правая открывает качества. Ожидание
    // разведки живёт только за правой зоной, где его сами попросили
    items.push({
      label: 'Скачать видео',
      run: () => void send(video, { chosen: true }),
      aside: { hint: 'Лучшее', run: () => void send(video, { wantVariants: true }) },
    });
    items.push({ label: 'Только звук', run: () => void send(video, { streams: 'audio', chosen: true }) });
    const poster = posterOf(t);
    if (poster) {
      items.push({
        label: 'Скачать превью',
        run: () => void send({ el: t.el, kind: 'image', url: poster }, { chosen: true }),
      });
    }
  } else {
    items.push({
      label: 'Скачать картинку',
      run: () => void send({ el: t.el, kind: 'image', url: t.url }, { chosen: true }),
    });
    if (t.postUrl) {
      const fromPost: PickTarget = { el: t.el, kind: 'video', postUrl: t.postUrl };
      items.push({
        label: 'Скачать видео',
        run: () => void send(fromPost, { chosen: true }),
        aside: { hint: 'Лучшее', run: () => void send(fromPost, { wantVariants: true }) },
      });
    }
  }

  openMenu(x, y, items);
  void labelAside(t);
}

/** Зона качества: «1080p ▾» — качества известны, «Авто» с кольцом — пробив идёт */
function paintAside(label?: string, pending = false): void {
  const more = menuEl?.querySelector<HTMLButtonElement>('.split .more');
  if (!more) return;
  more.textContent = '';
  // «1080p · 24,7 МБ» → «1080p»: в зону влезает только само качество
  more.append(label ? label.split(' · ')[0] : 'Лучшее');
  if (pending) {
    more.classList.add('pending');
    const ring = document.createElement('span');
    ring.className = 'more-ring';
    more.append(ring);
    return;
  }
  more.classList.remove('pending');
  more.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  if (label) {
    // Короткая вспышка: зона созрела, даже если смотрел в другое место
    more.classList.add('ready');
    window.setTimeout(() => more.classList.remove('ready'), 500);
  }
}

let asidePoll = 0;

/** Спрашиваем качества и, пока их нет, ждём разведку — она уже запущена */
async function labelAside(t: PickTarget): Promise<void> {
  const ask = (warm: boolean): Promise<{ variants?: PickVariant[]; probing?: boolean } | undefined> =>
    chrome.runtime
      .sendMessage({ type: 'known-variants', url: t.url, pageUrl: t.postUrl, warm })
      .catch(() => undefined);

  const res = await ask(true);
  if (!menuEl) return;
  const first = res?.variants?.[0]?.label;
  if (first) {
    paintAside(first);
    return;
  }
  if (!res?.probing) return;

  paintAside(undefined, true);
  window.clearInterval(asidePoll);
  asidePoll = window.setInterval(() => {
    if (!menuEl) {
      window.clearInterval(asidePoll);
      return;
    }
    void ask(false).then((later) => {
      const ready = later?.variants?.[0]?.label;
      if (!ready || !menuEl) return;
      window.clearInterval(asidePoll);
      paintAside(ready);
      log('качества доехали, пока меню открыто');
    });
  }, 600);
}

document.addEventListener(
  'contextmenu',
  (e) => {
    if (!pickerOn) return;
    // По своему же меню правый клик пропускаем: пусть закроется как обычно
    if (overOwnUi(e.clientX, e.clientY)) return;
    const t = pickAt(e.clientX, e.clientY);
    if (!t) return; // мимо медиа — родное меню браузера не отбираем
    e.preventDefault();
    e.stopPropagation();
    hovered = t;
    showAllOptions(t, e.clientX, e.clientY);
  },
  true,
);

function markTaken(key: string | undefined): void {
  if (key) takenKeys.add(key);
  if (hovered) drawFrame(hovered);
}

async function send(t: PickTarget, opts: SendOpts = {}): Promise<void> {
  const sentUrl = opts.url ?? t.url;
  if (opts.wantVariants) showBusy();
  const res = await chrome.runtime.sendMessage({
    type: 'pick',
    kind: opts.kind ?? t.kind,
    url: opts.url ?? t.url,
    postUrl: t.postUrl,
    variantUrl: opts.variantUrl,
    variantLabel: opts.variantLabel,
    streams: opts.streams,
    chosen: opts.chosen,
    wantVariants: opts.wantVariants,
    pageUrl: location.href,
    pageTitle: document.title,
  });
  // Есть из чего выбрать — сначала спрашиваем, качаем вторым заходом
  const variants = res?.variants as PickVariant[] | undefined;
  if (variants?.length) {
    showMenu(variants, t, lastMenuAt.x, lastMenuAt.y);
    return;
  }
  // Просили качества, а выбора нет — говорим об этом на месте. Загрузку эта
  // зона не запускает никогда: качает только сам пункт или конкретное качество
  if (opts.wantVariants) {
    // Сайт мог не пустить разведку — тогда качества есть, просто не для нас
    const why = res?.probeHint as string | undefined;
    openMenu(lastMenuAt.x, lastMenuAt.y, [
      { label: why ?? 'Другого качества нет', run: () => undefined, note: true },
    ]);
    window.setTimeout(closeMenu, why ? 4200 : 1600);
    return;
  }
  // Фон объясняет отказ словами — например, что пост у ролика не опознан и
  // качать надо с его страницы. Раньше этот текст никто не читал, и клик
  // просто ничего не делал: ни загрузки, ни причины
  const error = res?.error as string | undefined;
  if (!res?.ok && error) {
    showNote(error);
    window.setTimeout(hideNote, 6000);
    return;
  }
  // Галку ставим по факту загрузки, а не по успеху запроса: ответ «вариантов
  // нет» тоже приходит с ok, и рамка зеленела там, где ничего не качалось
  if (res?.ok && res.jobId) markTaken(sentUrl ?? t.postUrl);
}

function setPicker(on: boolean): void {
  if (pickerOn === on) return;
  pickerOn = on;
  setCursor(on);
  closeMenu();
  if (on) {
    // Панель — общий дом для подсказки прицела и строк загрузок
    if (TOP_FRAME) panel();
    // На таких площадках прицел просто не найдёт медиа и выключится по клику,
    // как будто сломался. Предупреждаем сразу, а не оставляем тыкать впустую
    if (TOP_FRAME) {
      const why = unsupportedReason(location.href);
      if (why) showNote(why);
    }
  } else {
    drawFrame(null);
    hovered = null;
    hideNote();
  }
  syncHead();
  closePanelIfIdle();
}

function leavePicker(why: string): void {
  log(`выходим из прицела: ${why}`);
  setPicker(false);
  void chrome.runtime.sendMessage({ type: 'picker-off' }).catch(() => {});
}

// Сайт не должен ничего успеть по нашему клику: озон открывает галерею уже
// по pointerdown, и его переход гасил прицел прямо под руками
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'auxclick'] as const) {
  document.addEventListener(
    type,
    (e) => {
      if (!pickerOn) return;
      const point = e as MouseEvent;
      if (overOwnUi(point.clientX, point.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

// Поиск мишени лазает по DOM — на каждый пиксель движения это слишком дорого
let moveScheduled = false;
document.addEventListener(
  'mousemove',
  (e) => {
    if (!pickerOn || menuEl) return;
    // Состояние Alt берём из самого события: оно доедет и без фокуса в документе
    const alt = e.altKey;
    const altChanged = alt !== greedy;
    greedy = alt;
    if (moveScheduled && !altChanged) return;
    moveScheduled = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      moveScheduled = false;
      if (!pickerOn || menuEl) return;
      lastPoint = { x: clientX, y: clientY };
      const t = pickAt(clientX, clientY);
      // Тот же элемент — рамка уже на месте, лишний раз не дёргаем.
      // Alt мог поменять саму добычу, тогда перерисовываем в любом случае
      if (!altChanged && t?.el === hovered?.el) return;
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
    // Клик по нашему меню или по крестику в панели — пусть отработает кнопка
    if (overOwnUi(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl) {
      closeMenu();
      return;
    }
    const t = pickAt(e.clientX, e.clientY);
    // Клик мимо медиа — выходим: страница должна вернуться к хозяину
    if (!t) {
      leavePicker('клик мимо медиа');
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

/** Пересчитать мишень под курсором: Alt мог изменить, что считается добычей */
let lastPoint = { x: 0, y: 0 };
function refreshHover(): void {
  if (!pickerOn || menuEl) return;
  const t = pickAt(lastPoint.x, lastPoint.y);
  hovered = t;
  drawFrame(t);
}

for (const type of ['keydown', 'keyup'] as const) {
  document.addEventListener(
    type,
    (e) => {
      if (!pickerOn) return;
      const next = (e as KeyboardEvent).altKey;
      if (next === greedy) return;
      greedy = next;
      refreshHover();
    },
    true,
  );
}

// Alt мог быть зажат ещё до входа в прицел или нажат вне документа —
// сверяемся при любом касании мыши, там состояние клавиш всегда актуально
for (const type of ['mouseover', 'mousedown', 'wheel'] as const) {
  document.addEventListener(
    type,
    (e) => {
      if (!pickerOn || menuEl) return;
      const alt = (e as MouseEvent).altKey;
      if (alt === greedy) return;
      greedy = alt;
      refreshHover();
    },
    true,
  );
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!pickerOn || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    leavePicker('нажат ESC');
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
    // Панель живёт и после выхода из прицела: загрузка идёт своим ходом
    else if (msg?.type === 'page-jobs' && TOP_FRAME) {
      for (const job of msg.jobs ?? []) updateJob(job);
    }
  },
);

// ---------- Панель Downy: что происходит с загрузками, начатыми со страницы ----------
//
// Попап в этот момент закрыт, и без панели клик прицелом выглядит так, будто
// ничего не произошло. Всё живёт одним блоком, а не россыпью карточек: прицел
// липкий, картинки таскают пачками, и десяток отдельных теней в углу — это
// свалка. Готовое сворачивается в одну строку итога, поэтому пачка из двадцати
// картинок не растит блок вовсе.

/** Уголок в правом нижнем углу: панель — его единственный жилец */
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

const ICON_KINDS = new Set<FileKind>(['video', 'image', 'audio', 'other']);

/** Дольше этого — результат стоит подержать: человек уже забыл, что качал */
const DONE_LONG_MS = 10_000;
/** Сколько на экране живёт строка «скачано N» после последней загрузки.
 *  Шести секунд хватало, чтобы блок начал мозолить глаза: имя файла человек
 *  уже видел, а итог читается за мгновение */
const ROLLUP_MS = 2500;

interface Row {
  node: HTMLDivElement;
  state: HTMLSpanElement;
  spin: HTMLSpanElement;
  meta: HTMLDivElement | null;
  fill: HTMLDivElement;
  startedAt: number;
  finished: boolean;
}

const rows = new Map<string, Row>();
let listEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let hintEl: HTMLSpanElement | null = null;
let footEl: HTMLDivElement | null = null;
let footTimer = 0;
let doneCount = 0;
let doneBytes = 0;

function activeRows(): number {
  let n = 0;
  for (const row of rows.values()) if (!row.finished) n++;
  return n;
}

function syncHead(): void {
  if (countEl) {
    const n = activeRows();
    countEl.textContent = n > 0 ? String(n) : '';
    countEl.hidden = n === 0;
  }
  // Про правый клик иначе никто не узнает: подсказка живёт там же, где режим
  if (hintEl) hintEl.textContent = pickerOn ? 'Правый клик — варианты · Alt — мелочь · ESC' : '';
}

function panel(): HTMLDivElement {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.className = 'panel';

  const head = document.createElement('div');
  head.className = 'p-head';
  const brand = document.createElement('b');
  brand.textContent = 'Downy';
  hintEl = document.createElement('span');
  hintEl.className = 'p-hint';
  countEl = document.createElement('span');
  countEl.className = 'p-count';
  countEl.hidden = true;
  head.append(brand, hintEl, countEl);

  listEl = document.createElement('div');
  panelEl.append(head, listEl);
  cornerBox().append(panelEl);
  syncHead();
  return panelEl;
}

/** Строка «здесь не выйдет» в панели: не ошибка загрузки, а объяснение, чтобы
 *  человек не искал, что он сделал не так. Живёт, пока прицел включён. */
let noteEl: HTMLDivElement | null = null;

function showNote(text: string): void {
  const root = panel();
  if (!noteEl) {
    noteEl = document.createElement('div');
    noteEl.className = 'p-note';
    root.append(noteEl);
  }
  noteEl.textContent = text;
}

function hideNote(): void {
  noteEl?.remove();
  noteEl = null;
}

/** Блок уходит, когда рассказывать больше не о чем */
function closePanelIfIdle(): void {
  if (!panelEl || pickerOn) return;
  if (rows.size > 0 || footEl) return;
  hideNote();
  const gone = panelEl;
  panelEl = null;
  listEl = countEl = hintEl = null;
  gone.classList.add('out');
  window.setTimeout(() => gone.remove(), 200);
}

function typeIcon(kind?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'p-icon';
  span.innerHTML = typeIconSvg(ICON_KINDS.has(kind as FileKind) ? (kind as FileKind) : 'video');
  return span;
}

/** Крестик отмены — проявляется при наведении на строку */
function cancelBtn(jobId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'p-cancel';
  btn.title = 'Отменить загрузку';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    log(`отменяем загрузку ${jobId}`);
    void chrome.runtime.sendMessage({ type: 'cancel-job', jobId }).catch(() => {});
  });
  return btn;
}

/**
 * Строка загрузки. Высота задаётся сразу и больше не меняется: полоса и место
 * под метрики есть с самого начала, иначе появление процентов дёргало бы
 * соседние строки. Метрики заводим только видео — картинке показывать нечего.
 */
function makeRow(job: PageJob): Row {
  const node = document.createElement('div');
  node.className = 'p-item';

  const line = document.createElement('div');
  line.className = 'p-line';

  const name = document.createElement('span');
  name.className = 'p-name';
  name.textContent = job.label;
  name.title = job.label;

  const spin = document.createElement('span');
  spin.className = 'p-spin';

  const state = document.createElement('span');
  state.className = 'p-state';

  line.append(typeIcon(job.mediaKind), name, spin, state, cancelBtn(job.jobId));

  const withMeta = job.mediaKind !== 'image';
  let meta: HTMLDivElement | null = null;
  if (withMeta) {
    meta = document.createElement('div');
    meta.className = 'p-meta';
  }

  const bar = document.createElement('div');
  bar.className = 'p-bar';
  const fill = document.createElement('div');
  fill.className = 'p-fill';
  bar.append(fill);

  node.append(line);
  if (meta) node.append(meta);
  node.append(bar);

  const list = panel() && listEl!;
  list.insertBefore(node, list.firstChild);

  return { node, state, spin, meta, fill, startedAt: Date.now(), finished: false };
}

function showRollup(): void {
  panel();
  if (!footEl) {
    footEl = document.createElement('div');
    footEl.className = 'p-foot';
    panelEl!.append(footEl);
  }
  footEl.textContent = `скачано ${doneCount} · ${fmtSize(doneBytes)}`;
  window.clearTimeout(footTimer);
  footTimer = window.setTimeout(() => {
    doneCount = 0;
    doneBytes = 0;
    footEl?.remove();
    footEl = null;
    closePanelIfIdle();
  }, ROLLUP_MS);
}

function dropRow(jobId: string, after: number): void {
  window.setTimeout(() => {
    const row = rows.get(jobId);
    if (!row) return;
    row.node.remove();
    rows.delete(jobId);
    showRollup();
    syncHead();
    closePanelIfIdle();
  }, after);
}

function updateJob(job: PageJob): void {
  if (job.state === 'canceled') {
    const row = rows.get(job.jobId);
    row?.node.remove();
    rows.delete(job.jobId);
    syncHead();
    closePanelIfIdle();
    return;
  }

  let row = rows.get(job.jobId);
  if (!row) {
    row = makeRow(job);
    rows.set(job.jobId, row);
    syncHead();
  }
  if (row.finished) return;

  if (job.state === 'queued' || job.state === 'starting') {
    // Слова тут ничего не добавляют — крутится спиннер
    row.state.textContent = '';
    return;
  }

  if (job.state === 'running') {
    const ratio = job.progress ?? (job.totalBytes ? (job.bytes ?? 0) / job.totalBytes : null);
    if (ratio != null) {
      row.spin.hidden = true;
      row.fill.style.width = `${Math.round(ratio * 100)}%`;
      row.state.textContent = `${Math.round(ratio * 100)}%`;
    } else {
      row.state.textContent = fmtSize(job.bytes);
      row.spin.hidden = row.state.textContent !== '';
    }
    if (row.meta) {
      const speed = fmtSpeed(job.speedBps);
      const total = job.totalBytes ?? (ratio && job.bytes ? job.bytes / ratio : undefined);
      const eta =
        job.speedBps && total && job.bytes ? fmtEta((total - job.bytes) / job.speedBps) : '';
      row.meta.textContent = [speed, eta && `ост. ${eta}`].filter(Boolean).join(' · ');
    }
    return;
  }

  // Пауза — не финал: загрузка ждёт кнопку ▶ или поднимется сама после
  // обрыва. Раньше она проваливалась в общую ветку и объявлялась ошибкой,
  // а строка исчезала — человек видел смерть там, где всё живо
  if (job.state === 'paused') {
    row.spin.hidden = true;
    row.state.className = 'p-state';
    row.state.textContent = pausedLabel(job.pausedBy);
    if (row.meta) row.meta.textContent = '';
    return;
  }

  // Готово или ошибка — дальше строка только доживает своё
  row.finished = true;
  row.spin.hidden = true;
  if (row.meta) row.meta.textContent = '';
  syncHead();

  if (job.state === 'done') {
    row.fill.style.width = '100%';
    row.state.className = 'p-state ok';
    row.state.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
      '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
    row.state.append(fmtSize(job.bytes) || 'готово');
    doneCount++;
    doneBytes += job.bytes ?? 0;
    // Быстрая загрузка сама себе уведомление о старте: показали и убрали
    dropRow(job.jobId, Date.now() - row.startedAt < DONE_LONG_MS ? 900 : 2000);
  } else {
    row.fill.style.width = '0%';
    row.state.className = 'p-state err';
    // Панель тесная, объяснению тут места нет — оно уходит в подсказку, а в
    // строке остаётся короткий повод. В попапе наоборот: там под строкой
    // помещается фраза целиком
    row.state.textContent = job.hint ? 'нужны cookies' : 'ошибка';
    row.node.title = job.hint ?? job.message ?? '';
    dropRow(job.jobId, job.hint ? 9000 : 6000);
  }
}

interface PageJob {
  jobId: string;
  label: string;
  state: string;
  progress: number | null;
  bytes?: number;
  totalBytes?: number;
  speedBps?: number;
  mediaKind?: string;
  message?: string;
  /** Человеческое объяснение отказа — приезжает из фона вместе с ошибкой */
  hint?: string;
  /** Кто остановил: рука человека, вытеснение очередью или обрыв связи */
  pausedBy?: 'user' | 'preempt' | 'dropped';
}
