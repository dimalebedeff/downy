import { describe, expect, it } from 'vitest';
import type { ProbeFormat } from '../../shared/protocol';
import { pickQuality } from '../src/quality';

const GB = 1024 ** 3;

function fmt(height: number | undefined, sizeBytes: number | undefined, hasVideo = true, hasAudio = false): ProbeFormat {
  return { height, sizeBytes, hasVideo, hasAudio };
}

const audio = fmt(undefined, 0.05 * GB, false, true);

describe('pickQuality', () => {
  it('лучшее качество, когда всё влезает', () => {
    const r = pickQuality([fmt(1080, 1 * GB), fmt(720, 0.5 * GB), audio], 1080, 2 * GB);
    expect(r).toMatchObject({ height: 1080, fits: true });
    expect(r.estimateBytes).toBeCloseTo(1.05 * GB, -7);
  });

  it('уважает планку пользователя', () => {
    const r = pickQuality([fmt(2160, 1 * GB), fmt(720, 0.3 * GB), audio], 720, 2 * GB);
    expect(r.height).toBe(720);
  });

  it('спускается ниже, если оценка не влезает', () => {
    const r = pickQuality([fmt(1080, 2.5 * GB), fmt(720, 1.2 * GB), audio], 1080, 2 * GB);
    expect(r).toMatchObject({ height: 720, fits: true, originalHeight: 1080 });
  });

  it('совсем не влезает — отдаёт минимальное с fits: false', () => {
    const r = pickQuality([fmt(1080, 5 * GB), fmt(480, 3 * GB), audio], undefined, 2 * GB);
    expect(r).toMatchObject({ height: 480, fits: false });
  });

  it('муксованный формат (видео+аудио) не получает добавку за аудио', () => {
    const r = pickQuality([fmt(720, 1 * GB, true, true)], 1080, 2 * GB);
    expect(r.estimateBytes).toBe(1 * GB);
  });

  it('размеры неизвестны — берём желаемое и надеемся на пост-проверку', () => {
    const r = pickQuality([fmt(1080, undefined), fmt(720, undefined)], 1080, 2 * GB);
    expect(r).toMatchObject({ height: 1080, fits: true });
    expect(r.estimateBytes).toBeUndefined();
  });

  it('нет видеоформатов — height undefined', () => {
    const r = pickQuality([audio], 1080, 2 * GB);
    expect(r.height).toBeUndefined();
  });

  it('планка ниже минимального качества — берём минимальное', () => {
    const r = pickQuality([fmt(1080, 1 * GB), fmt(720, 0.5 * GB), audio], 360, 2 * GB);
    expect(r.height).toBe(720);
  });
});
