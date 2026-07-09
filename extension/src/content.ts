// Ловит медиа, которое видно в DOM (теги video/audio/source), и собирает превью:
// poster тега video, кадр из играющего видео, обложку страницы (og:image).
// Стримы через MSE (blob:) сюда не попадают — их видит background по сети.

interface DomMediaEntry {
  url: string;
  thumb?: string;
}

const reported = new Map<string, string | undefined>(); // url -> отправленный thumb
let sentPageThumb: string | undefined;
let sentMseKey = 'no'; // 'no' | 'yes' | 'thumb' — что уже сообщили про MSE-видео

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

/** Видео, играющее через MSE (blob:) — файл руками не взять, но yt-dlp справится. */
function mseVideo(): { thumb?: string } | null {
  for (const v of document.querySelectorAll('video')) {
    const src = v.currentSrc || v.src || '';
    if (src.startsWith('blob:')) return { thumb: mediaThumb(v) };
  }
  return null;
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
  const mse = mseVideo();
  const mseKey = mse ? (mse.thumb ? 'thumb' : 'yes') : 'no';
  // Про MSE сообщаем при появлении и когда дозрело превью; исчезновение не откатываем
  const mseChanged = mse != null && mseKey !== sentMseKey && sentMseKey !== 'thumb';
  if (media.length || pageThumbChanged || mseChanged) {
    sentPageThumb = pt;
    if (mseChanged) sentMseKey = mseKey;
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

collect();

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleCollect(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    collect();
  }, 1000);
}

new MutationObserver(scheduleCollect).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['src', 'poster'],
});

document.addEventListener('play', scheduleCollect, true);
document.addEventListener('loadedmetadata', scheduleCollect, true);
