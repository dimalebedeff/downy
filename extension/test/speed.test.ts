import { describe, expect, it } from 'vitest';
import { nextSpeed } from '../src/lib/speed';

const MB = 1024 * 1024;

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

  it('EMA сглаживает скачки', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    const t1 = nextSpeed(t0, 10 * MB, 1000); // 10 МБ/с
    const t2 = nextSpeed(t1, 10 * MB + 2 * MB, 2000); // мгновенная 2 МБ/с
    // Сглаженная между 2 и 10, ближе к прежней
    expect(t2.bps!).toBeGreaterThan(2 * MB);
    expect(t2.bps!).toBeLessThan(10 * MB);
  });

  it('остановка потока тянет скорость к нулю', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    let t = nextSpeed(t0, 10 * MB, 1000);
    for (let i = 2; i < 12; i++) t = nextSpeed(t, 10 * MB, i * 1000);
    expect(t.bps!).toBeLessThan(1 * MB);
  });

  it('откат байтов (резюм) сбрасывает трек', () => {
    const t0 = nextSpeed(undefined, 10 * MB, 0);
    const t1 = nextSpeed(t0, 12 * MB, 1000);
    expect(t1.bps).toBeDefined();
    const t2 = nextSpeed(t1, 1 * MB, 2000);
    expect(t2.bps).toBeUndefined();
    expect(t2.bytes).toBe(1 * MB);
  });

  it('замер в тот же миг не делит на ноль', () => {
    const t0 = nextSpeed(undefined, 0, 0);
    const t1 = nextSpeed(t0, 5 * MB, 0);
    expect(t1.bps).toBeUndefined();
    expect(t1.bytes).toBe(5 * MB);
  });
});
