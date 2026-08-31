import { describe, expect, it } from 'vitest';
import { readThemeChoice, resolveTheme, THEME_KEY } from '../src/lib/theme';

describe('readThemeChoice', () => {
  it('понимает все три состояния', () => {
    expect(readThemeChoice('light')).toBe('light');
    expect(readThemeChoice('dark')).toBe('dark');
    expect(readThemeChoice('system')).toBe('system');
  });

  it('мусор из хранилища не ломает попап — возвращаемся к системе', () => {
    expect(readThemeChoice(undefined)).toBe('system');
    expect(readThemeChoice(null)).toBe('system');
    expect(readThemeChoice('')).toBe('system');
    expect(readThemeChoice('тёмная')).toBe('system');
    expect(readThemeChoice(42)).toBe('system');
    expect(readThemeChoice({ theme: 'dark' })).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('явный выбор системе не подчиняется', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('«как в системе» идёт за системой', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('THEME_KEY', () => {
  it('ключ хранения один на попап и панель — иначе они разъедутся', () => {
    expect(THEME_KEY).toBe('theme');
  });
});
