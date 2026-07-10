import { describe, expect, it } from 'vitest';
import { fmtEta, fmtSize, fmtSpeed, jobProgressView } from '../src/lib/progress';

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

  it('со скоростью — компактно: процент, скорость, остаток', () => {
    const v = jobProgressView({ progress: null, bytes: 120 * MB, totalBytes: 480 * MB, speedBps: 12.4 * MB });
    expect(v.text).toBe(`25% · 12.4 МБ/с · ост. ${fmtEta((360 * MB) / (12.4 * MB))}`);
    expect(v.ratio).toBeCloseTo(0.25, 3);
  });

  it('скорость без общего размера — процент и скорость, остаток по оценке', () => {
    const v = jobProgressView({ progress: 0.25, bytes: 45 * MB, speedBps: 3 * MB });
    expect(v.text).toBe(`25% · 3.0 МБ/с · ост. ${fmtEta((135 * MB) / (3 * MB))}`);
  });

  it('скорость есть, а меры прогресса нет — байты и скорость без остатка', () => {
    const v = jobProgressView({ progress: null, bytes: 7 * MB, speedBps: 2 * MB });
    expect(v.text).toBe('7.0 МБ · 2.0 МБ/с');
    expect(v.ratio).toBeNull();
  });
});

describe('fmtSpeed', () => {
  it('нет данных или мелочь — пусто', () => {
    expect(fmtSpeed(undefined)).toBe('');
    expect(fmtSpeed(500)).toBe('');
  });

  it('человеческие единицы', () => {
    expect(fmtSpeed(12.4 * MB)).toBe('12.4 МБ/с');
    expect(fmtSpeed(300 * 1024)).toBe('300 КБ/с');
  });
});

describe('fmtEta', () => {
  it('минуты и секунды', () => {
    expect(fmtEta(80)).toBe('1:20');
    expect(fmtEta(5)).toBe('0:05');
  });

  it('часы', () => {
    expect(fmtEta(3900)).toBe('1:05:00');
  });

  it('мусор — пустая строка', () => {
    expect(fmtEta(undefined)).toBe('');
    expect(fmtEta(0)).toBe('');
    expect(fmtEta(-5)).toBe('');
    expect(fmtEta(Infinity)).toBe('');
    expect(fmtEta(1e9)).toBe('');
  });
});
