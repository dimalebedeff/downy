import { describe, expect, it } from 'vitest';
import { fmtSize, jobProgressView } from '../src/lib/progress';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('fmtSize', () => {
  it('пустой или нулевой размер — пустая строка', () => {
    expect(fmtSize(undefined)).toBe('');
    expect(fmtSize(0)).toBe('');
  });

  it('килобайты округляются, минимум 1 КБ', () => {
    expect(fmtSize(500)).toBe('1 КБ');
    expect(fmtSize(10 * 1024)).toBe('10 КБ');
  });

  it('мегабайты и гигабайты с одним знаком', () => {
    expect(fmtSize(12.3 * MB)).toBe('12.3 МБ');
    expect(fmtSize(2.5 * GB)).toBe('2.5 ГБ');
  });
});

describe('jobProgressView', () => {
  it('точный размер: скачано / всего, шкала по байтам', () => {
    const v = jobProgressView({ progress: null, bytes: 12.3 * MB, totalBytes: 480 * MB });
    expect(v.text).toBe('12.3 МБ / 480.0 МБ');
    expect(v.ratio).toBeCloseTo(12.3 / 480, 3);
  });

  it('прогресс по времени + байты без общего размера: оценка с тильдой', () => {
    const v = jobProgressView({ progress: 0.25, bytes: 45 * MB });
    expect(v.text).toBe('45.0 МБ / ~180.0 МБ');
    expect(v.ratio).toBe(0.25);
  });

  it('оценка не строится на слишком маленьком прогрессе', () => {
    const v = jobProgressView({ progress: 0.005, bytes: 2 * MB });
    expect(v.text).toBe('2.0 МБ');
    expect(v.ratio).toBe(0.005);
  });

  it('только байты: показываем сколько скачано, шкала неопределённая', () => {
    const v = jobProgressView({ progress: null, bytes: 7 * MB });
    expect(v.text).toBe('7.0 МБ');
    expect(v.ratio).toBeNull();
  });

  it('только прогресс: показываем проценты', () => {
    const v = jobProgressView({ progress: 0.42 });
    expect(v.text).toBe('42%');
    expect(v.ratio).toBe(0.42);
  });

  it('ничего не известно: заглушка и неопределённая шкала', () => {
    const v = jobProgressView({ progress: null });
    expect(v.text).toBe('идёт…');
    expect(v.ratio).toBeNull();
  });

  it('прогресс есть и по байтам, и по времени — шкала по явному прогрессу', () => {
    const v = jobProgressView({ progress: 0.5, bytes: 10 * MB, totalBytes: 40 * MB });
    expect(v.text).toBe('10.0 МБ / 40.0 МБ');
    expect(v.ratio).toBe(0.5);
  });
});
