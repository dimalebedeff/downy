/** Разбор того, что предлагает страница для выбранной кликом картинки. */

/**
 * Самый крупный кандидат из srcset. Дескрипторы бывают двух видов: "1024w" —
 * ширина в пикселях, "2x" — плотность пикселей. Сравнивать их между собой
 * нельзя, поэтому ширина всегда весомее плотности, а голый адрес без
 * дескриптора — слабее всех.
 */
export function bestFromSrcset(srcset: string | null | undefined): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const part of (srcset ?? '').split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    let rank = 1;
    if (descriptor?.endsWith('w')) {
      const w = parseFloat(descriptor);
      if (w > 0) rank = 1_000_000 + w;
    } else if (descriptor?.endsWith('x')) {
      const x = parseFloat(descriptor);
      if (x > 0) rank = 1_000 + x;
    }
    if (rank > bestRank) {
      bestRank = rank;
      best = url;
    }
  }
  return best;
}

/**
 * Имя для скачанной картинки — из последнего сегмента адреса. Пачка картинок
 * с одной страницы иначе получила бы десяток одинаковых имён, разведённых
 * только хвостами (1), (2).
 */
export function imageStem(url: string, fallback?: string): string | undefined {
  let name: string;
  try {
    name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return fallback;
  }
  let stem: string;
  try {
    stem = decodeURIComponent(name);
  } catch {
    stem = name; // кривые проценты в адресе — берём как есть
  }
  stem = stem.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  // Короткий или безликий сегмент ничего не объясняет — лучше заголовок страницы
  return stem.length > 2 && !/^(index|image|img|photo|default)$/i.test(stem) ? stem : fallback;
}

/**
 * Длинные идентификаторы ассета из пути. CDN кладут обложку и сам ролик по
 * соседству под общим ключом (ozon: /video-72/<ULID>/cover/wc100/cover.jpg и
 * /video-72/<ULID>/asset_1_h264.mp4), поэтому по превью можно дотянуться до
 * видео. Берём только сегменты, которые тянут на идентификатор: длинные и
 * смешанные из букв с цифрами — обычные слова пути так не выглядят.
 */
export function assetIds(url: string): string[] {
  let parts: string[];
  try {
    parts = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
  // Последний сегмент — имя файла: «asset_1_h264.mp4» подходит под все приметы
  // идентификатора, но у соседних роликов оно как раз совпадает
  return parts
    .slice(0, -1)
    .filter((p) => p.length >= 16 && /^[A-Za-z0-9._-]+$/.test(p) && /\d/.test(p) && /[A-Za-z]/.test(p));
}

/** Файл-превью: короткий немой огрызок, который CDN кладёт рядом с роликом */
const PREVIEW_FILE = /^preview\.[a-z0-9]{2,5}$/i;

/**
 * Адреса полных дорожек рядом с превью, от лучшей к худшей. Озон отдаёт
 * галерее `<id>/preview.mp4` — 10 секунд без звука, — а сам ролик лежит
 * соседом: `<id>/asset_2_h264.mp4` (720p), `asset_1` (540p), `asset_0` (360p).
 * Если в сеть попало только превью (видео не проигрывали), взять больше неоткуда.
 */
export function previewSiblings(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const parts = u.pathname.split('/');
  const name = parts[parts.length - 1];
  if (!PREVIEW_FILE.test(name)) return [];
  return ['asset_2_h264.mp4', 'asset_1_h264.mp4', 'asset_0_h264.mp4'].map((candidate) => {
    parts[parts.length - 1] = candidate;
    const sibling = new URL(u.toString());
    sibling.pathname = parts.join('/');
    return sibling.toString();
  });
}

/**
 * Адрес картинки, нарисованной фоном. Повторяющийся фон пропускаем: плитка —
 * это узор, рамка, шум, заглушка ленивой картинки, а не то, что человек метил
 * скачать. Яндекс.Еда кладёт поверх каждого баннера прозрачный слой с таким
 * паттерном, и прицел уносил один и тот же svg вместо самих баннеров.
 */
export function backgroundImageUrl(style: { backgroundImage: string; backgroundRepeat: string }): string | null {
  const bg = style.backgroundImage;
  if (!bg || bg === 'none') return null;
  const repeats = (style.backgroundRepeat ?? '').split(/\s+/).filter(Boolean);
  if (repeats.some((axis) => axis !== 'no-repeat')) return null;
  const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
  const raw = m?.[2];
  // data: и градиенты качать нечего
  if (!raw || raw.startsWith('data:')) return null;
  return raw;
}

/**
 * Обычный порог прицела. Ниже него — иконки интерфейса, аватарки, значки:
 * цеплять их по наведению значит мешать, а не помогать. Зажатый Alt порог
 * снимает, но словом «мелочь» подписано именно то, что порог не прошло, —
 * крупная картинка остаётся картинкой и с зажатой клавишей.
 */
export const MIN_PICK_SIZE = 100;

export function meetsPickThreshold(width: number, height: number): boolean {
  return width >= MIN_PICK_SIZE && height >= MIN_PICK_SIZE;
}
