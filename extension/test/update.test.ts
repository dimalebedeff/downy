import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/lib/update';

describe('isNewerVersion', () => {
  it('тег новее текущей версии', () => {
    expect(isNewerVersion('0.3.0', 'v0.4')).toBe(true);
    expect(isNewerVersion('0.3.0', 'v0.3.1')).toBe(true);
    expect(isNewerVersion('0.3.0', 'v1.0')).toBe(true);
  });

  it('тот же или старее — не новее', () => {
    expect(isNewerVersion('0.3.0', 'v0.3')).toBe(false);
    expect(isNewerVersion('0.3.0', 'v0.3.0')).toBe(false);
    expect(isNewerVersion('0.3.0', 'v0.2')).toBe(false);
    expect(isNewerVersion('0.3.0', 'v0.1')).toBe(false);
  });

  it('сегменты сравниваются как числа, не строки', () => {
    expect(isNewerVersion('0.9.0', 'v0.10')).toBe(true);
    expect(isNewerVersion('0.10.0', 'v0.9')).toBe(false);
  });

  it('работает без префикса v', () => {
    expect(isNewerVersion('0.3.0', '0.4')).toBe(true);
  });

  it('мусорный тег — не новее', () => {
    expect(isNewerVersion('0.3.0', '')).toBe(false);
    expect(isNewerVersion('0.3.0', 'latest')).toBe(false);
  });
});
