import { describe, expect, it } from 'vitest';
import {
  fmtEta,
  fmtSize,
  fmtSpeed,
  nextSpeed,
  renderBar,
  renderLine,
} from '../download-progress.mjs';

const MB = 1024 * 1024;

describe('fmtSize', () => {
  it('КБ / МБ / ГБ по порогам', () => {
    expect(fmtSize(500 * 1024)).toBe('500 КБ');
    expect(fmtSize(12.3 * MB)).toBe('12.3 МБ');
    expect(fmtSize(2 * 1024 * MB)).toBe('2.0 ГБ');
  });

  it('ноль и мусор — пустая строка', () => {
    expect(fmtSize(0)).toBe('');
    expect(fmtSize(undefined)).toBe('');
    expect(fmtSize(NaN)).toBe('');
  });
});

describe('fmtSpeed', () => {
  it('человекочитаемая скорость', () => {
    expect(fmtSpeed(2.1 * MB)).toBe('2.1 МБ/с');
  });

  it('неизвестную или мелкую скорость прячем', () => {
    expect(fmtSpeed(undefined)).toBe('');
    expect(fmtSpeed(500)).toBe('');
  });
});

describe('fmtEta', () => {
  it('MM:SS с ведущими нулями', () => {
    expect(fmtEta(6)).toBe('00:06');
    expect(fmtEta(65)).toBe('01:05');
    expect(fmtEta(306)).toBe('05:06');
  });

  it('часы добавляются при нужде', () => {
    expect(fmtEta(3665)).toBe('1:01:05');
  });

  it('нет данных или враньё — пусто', () => {
    expect(fmtEta(0)).toBe('');
    expect(fmtEta(undefined)).toBe('');
    expect(fmtEta(Infinity)).toBe('');
    expect(fmtEta(200 * 3600)).toBe('');
  });
});

describe('renderBar', () => {
  it('заполнение пропорционально доле', () => {
    expect(renderBar(0, 10)).toBe('░'.repeat(10));
    expect(renderBar(1, 10)).toBe('█'.repeat(10));
    expect(renderBar(0.5, 10)).toBe('█████░░░░░');
  });

  it('долю за пределами зажимаем', () => {
    expect(renderBar(-1, 4)).toBe('░░░░');
    expect(renderBar(5, 4)).toBe('████');
    expect(renderBar(NaN, 4)).toBe('░░░░');
  });
});

describe('nextSpeed', () => {
  it('первый замер — скорости ещё нет', () => {
    const t = nextSpeed(undefined, 5 * MB, 1000);
    expect(t.bps).toBeUndefined();
    expect(t.bytes).toBe(5 * MB);
  });

  it('второй замер — мгновенная скорость по дельте', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    const t1 = nextSpeed(t0, 2 * MB, 1000);
    expect(t1.bps).toBeCloseTo(2 * MB, 0);
  });

  it('EMA сглаживает скачок', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    const t1 = nextSpeed(t0, 10 * MB, 1000);
    const t2 = nextSpeed(t1, 12 * MB, 2000);
    expect(t2.bps).toBeGreaterThan(2 * MB);
    expect(t2.bps).toBeLessThan(10 * MB);
  });

  it('замер в тот же миг не делит на ноль', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    const t1 = nextSpeed(t0, 5 * MB, 0);
    expect(t1.bps).toBeUndefined();
  });
});

describe('renderLine', () => {
  it('известный размер — процент, шкала и ETA', () => {
    const line = renderLine({
      name: 'ffmpeg.exe',
      downloaded: 5 * MB,
      total: 10 * MB,
      speedBps: 1 * MB,
      barWidth: 10,
    });
    expect(line).toContain('ffmpeg.exe');
    expect(line).toContain('50%');
    expect(line).toContain('5.0 МБ / 10.0 МБ');
    expect(line).toContain('1.0 МБ/с');
    expect(line).toContain('осталось 00:05');
  });

  it('неизвестный размер — без шкалы и ETA', () => {
    const line = renderLine({
      name: 'yt-dlp.exe',
      downloaded: 3 * MB,
      total: 0,
      speedBps: 1 * MB,
    });
    expect(line).toContain('yt-dlp.exe');
    expect(line).toContain('3.0 МБ');
    expect(line).not.toContain('%');
    expect(line).not.toContain('осталось');
  });
});
