/**
 * Выбор темы. Состояний три, а не два: кроме светлой и тёмной есть «как в
 * системе» — и оно по умолчанию. Без него человек, ткнувший однажды, уже не
 * вернёт автоматику, а она нужна тем, у кого Windows переключается сам.
 *
 * Выбор хранится в chrome.storage.local, чтобы его видели и попап, и панель
 * прицела на странице: тема, разъехавшаяся между частями интерфейса, хуже
 * отсутствия выбора вовсе.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

/** Ключ один на всех — попап пишет, панель читает */
export const THEME_KEY = 'theme';

const CHOICES: ThemeChoice[] = ['light', 'dark', 'system'];

/** Что бы ни лежало в хранилище, интерфейс должен нарисоваться */
export function readThemeChoice(raw: unknown): ThemeChoice {
  return CHOICES.includes(raw as ThemeChoice) ? (raw as ThemeChoice) : 'system';
}

/** Какую тему рисовать прямо сейчас */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}
