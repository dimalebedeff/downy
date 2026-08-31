import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Проверки правил проекта, которые иначе живут только в голове и в CLAUDE.md.
 * Ревьюер их проглядывает, агент замечает раз в месяц — а тест ловит сразу.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('версия одна на три файла', () => {
  // Самообновление сравнивает тег релиза с версией в манифесте, а хост
  // отвечает своей. Разъехались — обновление либо не предложится, либо
  // предложится вечно. Проверять глазами перед каждым релизом ненадёжно
  it('manifest, package.json и хост говорят одно и то же', () => {
    const manifest = JSON.parse(read('extension/manifest.json')).version;
    const pkg = JSON.parse(read('package.json')).version;
    const host = read('coapp/src/host.ts').match(/const VERSION = '([^']+)'/)?.[1];
    expect({ manifest, pkg, host }).toEqual({ manifest, pkg: manifest, host: manifest });
  });

  it('README зовёт папку релиза текущей версией', () => {
    const version = JSON.parse(read('package.json')).version;
    expect(read('README.md')).toContain(`downy-${version}`);
  });
});

describe('одно понятие — одно слово', () => {
  /** Файлы, где живут надписи для человека */
  const UI_FILES = [
    'extension/src/popup/popup.ts',
    'extension/src/popup/popup.html',
    'extension/src/content.ts',
    'extension/src/background.ts',
    'coapp/src/host.ts',
  ];

  /** Строки в кавычках, комментарии отброшены: жаргон в пояснениях допустим */
  function uiStrings(rel: string): string[] {
    const out: string[] = [];
    for (const raw of read(rel).split('\n')) {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      for (const m of line.matchAll(/'([^']{2,})'|"([^"]{2,})"|`([^`]{2,})`/g)) {
        const text = m[1] ?? m[2] ?? m[3] ?? '';
        // Только осмысленный русский текст, а не селекторы и ключи
        if (/[а-яё]/i.test(text)) out.push(text);
      }
    }
    return out;
  }

  const BANNED: { word: RegExp; instead: string; why: string }[] = [
    { word: /обложк/i, instead: 'превью', why: 'попап звал «обложкой» то же, что прицел звал «превью»' },
    // Без флага регистра: «coapp:fetch-bins» — имя npm-скрипта, его человек и должен набрать
    { word: /CoApp/, instead: 'Downy на компьютере', why: 'в интерфейсе это имя ничего не объясняет' },
    { word: /ПКМ/, instead: 'правый клик', why: 'единственная аббревиатура в интерфейсе' },
    { word: /нашелся/i, instead: 'нашёлся', why: 'проект пишет ё' },
    // «Авто» жило в прицеле там, где попап писал «Лучшее» — одно качество, два слова
    { word: /^Авто$/, instead: 'Лучшее', why: 'качество по умолчанию зовётся одинаково везде' },
    { word: /(нажми|тыкай|тащи|дождись|запусти|установи)/i, instead: 'вы', why: 'интерфейс обращается на «вы»' },
  ];

  for (const { word, instead, why } of BANNED) {
    it(`вместо «${word.source}» говорим «${instead}» (${why})`, () => {
      const hits: string[] = [];
      for (const file of UI_FILES) {
        for (const text of uiStrings(file)) {
          if (word.test(text)) hits.push(`${file}: ${text}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});

describe('движение уважает системную настройку', () => {
  // Человек, выключивший анимации в системе, не должен видеть у нас
  // крутилки и бегущие полосы — это не украшение, а требование доступности
  it('в стилях попапа на каждую анимацию есть prefers-reduced-motion', () => {
    const css = read('extension/src/popup/popup.css');
    const animated = css.includes('animation:');
    expect(animated && css.includes('prefers-reduced-motion')).toBe(true);
  });

  it('в стилях страницы тоже', () => {
    const content = read('extension/src/content.ts');
    const animated = content.includes('animation: spin');
    expect(animated && content.includes('prefers-reduced-motion')).toBe(true);
  });
});

describe('тема одна', () => {
  // Светлую убрали сознательно; вернётся она только с обоими бортами сразу,
  // а не одним забытым медиазапросом
  it('в интерфейсе не осталось переключения по системной теме', () => {
    expect(read('extension/src/popup/popup.css')).not.toContain('prefers-color-scheme');
    expect(read('extension/src/content.ts')).not.toContain('prefers-color-scheme');
  });
});
