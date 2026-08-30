// Кто из похожих файлов настоящий. Судим по содержимому, а не по имени:
// см. shared/ffmpeg-info.ts, который это содержимое достаёт.

import type { ProbedMedia } from '../../../shared/ffmpeg-info';

export type { ProbedMedia };

/** Разница длительностей, ниже которой это один и тот же ролик в разном качестве */
const SAME_CLIP_TOLERANCE = 0.2;

/**
 * Кто из кандидатов настоящий. Порядок важности: звук, потом заметно большая
 * длительность (огрызок против полного ролика), потом размер кадра. Сравниваем
 * именно в таком порядке, потому что немой файл бесполезен, каким бы он ни был
 * чётким, а десять секунд из тридцати трёх — не «другое качество», а обрезок.
 */
export function pickBestMedia(list: ProbedMedia[]): ProbedMedia | undefined {
  const usable = list.filter((m) => m.ok);
  if (usable.length === 0) return undefined;
  return usable.slice().sort(compareMedia)[0];
}

function compareMedia(a: ProbedMedia, b: ProbedMedia): number {
  if (!!a.hasAudio !== !!b.hasAudio) return a.hasAudio ? -1 : 1;

  const da = a.durationSec ?? 0;
  const db = b.durationSec ?? 0;
  if (da > 0 && db > 0) {
    const diff = Math.abs(da - db) / Math.max(da, db);
    if (diff > SAME_CLIP_TOLERANCE) return db - da;
  } else if (da !== db) {
    return db - da; // известная длительность лучше неизвестной
  }

  const areaA = (a.width ?? 0) * (a.height ?? 0);
  const areaB = (b.width ?? 0) * (b.height ?? 0);
  return areaB - areaA;
}
