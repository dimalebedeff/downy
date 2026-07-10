// Выбор качества под лимит отправки Telegram по данным разведки yt-dlp.

import type { ProbeFormat } from '../../shared/protocol';

export interface QualityPick {
  /** Планка для yt-dlp; undefined — видеоформатов нет, качаем как есть */
  height?: number;
  /** Оценка размера; undefined — у форматов нет данных о размере */
  estimateBytes?: number;
  /** false — даже минимальное качество не влезает в лимит */
  fits: boolean;
  /** Лучшее доступное качество (для пометки «отправил ниже, чем есть») */
  originalHeight?: number;
}

/** Оценка размера при данной высоте: самый тяжёлый видеоформат + аудио */
function estimateAt(formats: ProbeFormat[], height: number): number | undefined {
  const candidates = formats.filter((f) => f.hasVideo && f.height === height);
  if (candidates.length === 0) return undefined;
  const sized = candidates.filter((f) => f.sizeBytes != null);
  if (sized.length === 0) return undefined;
  const video = sized.reduce((a, b) => (b.sizeBytes! > a.sizeBytes! ? b : a));
  if (video.hasAudio) return video.sizeBytes;
  const audioSizes = formats.filter((f) => f.hasAudio && !f.hasVideo && f.sizeBytes != null).map((f) => f.sizeBytes!);
  return video.sizeBytes! + (audioSizes.length ? Math.max(...audioSizes) : 0);
}

/**
 * Идём по доступным высотам сверху вниз (не выше wanted) и берём первую,
 * чья оценка влезает в лимит. Без данных о размере — берём и надеемся на
 * проверку фактического размера после скачивания.
 */
export function pickQuality(formats: ProbeFormat[], wanted: number | undefined, limitBytes: number): QualityPick {
  const heights = [...new Set(formats.filter((f) => f.hasVideo && f.height).map((f) => f.height!))].sort((a, b) => b - a);
  if (heights.length === 0) return { fits: true };

  const originalHeight = heights[0];
  const capped = wanted ? heights.filter((h) => h <= wanted) : heights;
  // Планка ниже минимального качества — берём минимальное, лучше чем ничего
  const ladder = capped.length > 0 ? capped : [heights[heights.length - 1]];

  let lowest: QualityPick | null = null;
  for (const h of ladder) {
    const estimateBytes = estimateAt(formats, h);
    const pick: QualityPick = { height: h, estimateBytes, fits: true, originalHeight };
    if (estimateBytes == null || estimateBytes <= limitBytes) return pick;
    lowest = pick;
  }
  return { ...lowest!, fits: false };
}
