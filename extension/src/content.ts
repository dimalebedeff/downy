// Ловит медиа, которое видно в DOM (теги video/audio/source).
// Стримы через MSE (blob:) сюда не попадают — их видит background по сети.

const reported = new Set<string>();

function collect(): void {
  const urls: string[] = [];
  const els = document.querySelectorAll<HTMLElement>('video, audio, source');
  for (const el of els) {
    const raw =
      (el as HTMLMediaElement).currentSrc || el.getAttribute('src') || '';
    if (!raw) continue;
    let abs: string;
    try {
      abs = new URL(raw, location.href).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith('http')) continue; // blob:, data: и т.п. пропускаем
    if (reported.has(abs)) continue;
    reported.add(abs);
    urls.push(abs);
  }
  if (urls.length) {
    void chrome.runtime
      .sendMessage({ type: 'dom-media', urls, pageTitle: document.title, pageUrl: location.href })
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
  attributeFilter: ['src'],
});

document.addEventListener('play', scheduleCollect, true);
document.addEventListener('loadedmetadata', scheduleCollect, true);
