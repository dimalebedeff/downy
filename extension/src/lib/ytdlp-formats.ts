import type { ProbeFormat } from '../../../shared/protocol';
import { fmtSize } from './progress';

/** Пункт выбора качества: планка высоты для yt-dlp и человеческая метка */
export interface QualityOption {
  maxHeight: number;
  /** Например «1080p60 · ~350.0 МБ» */
  label: string;
}

/**
 * Схлопывает форматы разведки в короткий список по высоте: юзер думает
 * в категориях «качество и вес», а не «vp9 против av1». Внутри высоты
 * yt-dlp сам возьмёт лучший кодек.
 */
export function qualityOptions(formats: ProbeFormat[]): QualityOption[] {
  // Лучшая аудиодорожка — её вес добавляем к видео-only форматам
  let bestAudio = 0;
  for (const f of formats) {
    if (!f.hasVideo && f.hasAudio && f.sizeBytes && f.sizeBytes > bestAudio) bestAudio = f.sizeBytes;
  }

  const byHeight = new Map<number, { size: number; needsAudio: boolean; fps: number }>();
  for (const f of formats) {
    if (!f.hasVideo || !f.height) continue;
    const cur = byHeight.get(f.height) ?? { size: 0, needsAudio: true, fps: 0 };
    if (f.fps && f.fps > cur.fps) cur.fps = f.fps;
    if ((f.sizeBytes ?? 0) > cur.size) {
      cur.size = f.sizeBytes ?? 0;
      cur.needsAudio = !f.hasAudio;
    }
    byHeight.set(f.height, cur);
  }

  return [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .map(([height, info]) => {
      const fpsMark = info.fps >= 50 ? String(Math.round(info.fps)) : '';
      const total = info.size ? info.size + (info.needsAudio ? bestAudio : 0) : 0;
      const size = total ? ` · ~${fmtSize(total)}` : '';
      return { maxHeight: height, label: `${height}p${fpsMark}${size}` };
    });
}
