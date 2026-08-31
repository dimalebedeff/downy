import { describe, expect, it } from 'vitest';
import { looksLikeAuthFailure } from '../src/lib/cookies';
import { cookiesToHeader, toNetscapeCookieFile, type BrowserCookie } from '../../shared/cookies';

const TAB = '\t';
const NL = '\n';

function cookie(over: Partial<BrowserCookie> & { name: string; value: string }): BrowserCookie {
  return { domain: '.example.com', path: '/', secure: true, hostOnly: false, session: false, ...over };
}

/** Строки записей без строки-заголовка */
function rows(file: string | null): string[][] {
  return (file ?? '')
    .split(NL)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(TAB));
}

describe('toNetscapeCookieFile', () => {
  it('пишет строку в формате, который читает yt-dlp', () => {
    const out = toNetscapeCookieFile([
      cookie({ name: 'sessionid', value: 'abc123', domain: '.instagram.com', expirationDate: 1893456000 }),
    ]);
    expect(rows(out)).toEqual([['.instagram.com', 'TRUE', '/', 'TRUE', '1893456000', 'sessionid', 'abc123']]);
  });

  it('кука одного хоста не растекается на поддомены', () => {
    const out = toNetscapeCookieFile([cookie({ name: 'a', value: '1', domain: 'vk.com', hostOnly: true })]);
    expect(rows(out)[0].slice(0, 2)).toEqual(['vk.com', 'FALSE']);
  });

  it('незащищённая кука помечается как незащищённая', () => {
    const out = toNetscapeCookieFile([cookie({ name: 'a', value: '1', secure: false })]);
    expect(rows(out)[0][3]).toBe('FALSE');
  });

  it('сессионной куке ставим ноль вместо срока', () => {
    const out = toNetscapeCookieFile([cookie({ name: 'a', value: '1', session: true })]);
    expect(rows(out)[0][4]).toBe('0');
  });

  it('дробный срок округляем: в файле только целые секунды', () => {
    const out = toNetscapeCookieFile([cookie({ name: 'a', value: '1', expirationDate: 1893456000.77 })]);
    expect(rows(out)[0][4]).toBe('1893456000');
  });

  it('перевод строки в значении выкидывает куку целиком', () => {
    // Иначе одна кука дописала бы в файл строки от себя
    const evil = ['x', ['evil.com', 'TRUE', '/', 'TRUE', '0', 'stolen', '1'].join(TAB)].join(NL);
    const out = toNetscapeCookieFile([
      cookie({ name: 'ok', value: 'fine' }),
      cookie({ name: 'bad', value: evil }),
      cookie({ name: 'tabbed', value: ['a', 'b'].join(TAB) }),
    ]);
    expect(rows(out).map((r) => r[5])).toEqual(['ok']);
    expect(out).not.toContain('evil.com');
  });

  it('один и тот же ключ из двух источников кладём один раз', () => {
    const out = toNetscapeCookieFile([
      cookie({ name: 'sid', value: '1', domain: '.a.com', path: '/' }),
      cookie({ name: 'sid', value: '1', domain: '.a.com', path: '/' }),
      cookie({ name: 'sid', value: '2', domain: '.b.com', path: '/' }),
    ]);
    expect(rows(out)).toHaveLength(2);
  });

  it('без кук файл не выдумываем', () => {
    expect(toNetscapeCookieFile([])).toBeNull();
  });

  it('первая строка — заголовок формата', () => {
    const out = toNetscapeCookieFile([cookie({ name: 'a', value: '1' })]);
    expect(out?.split(NL)[0]).toBe('# Netscape HTTP Cookie File');
  });
});

describe('cookiesToHeader', () => {
  it('склеивает пары так, как их шлёт браузер', () => {
    const file = toNetscapeCookieFile([cookie({ name: 'sid', value: 'abc' }), cookie({ name: 'csrf', value: 'xyz' })]);
    expect(cookiesToHeader(file ?? undefined)).toBe('sid=abc; csrf=xyz');
  });

  it('заголовок и комментарии в файле пропускает', () => {
    expect(cookiesToHeader(['# Netscape HTTP Cookie File', '# что-то ещё'].join(NL))).toBeUndefined();
  });

  it('обрезанную строку не берёт: лучше без куки, чем с половиной', () => {
    expect(cookiesToHeader(['.a.com', 'TRUE', '/', 'TRUE', '0'].join(TAB))).toBeUndefined();
  });

  it('пустой ввод не превращаем в пустой заголовок', () => {
    expect(cookiesToHeader(undefined)).toBeUndefined();
    expect(cookiesToHeader('')).toBeUndefined();
  });
});

describe('looksLikeAuthFailure', () => {
  it('узнаёт отказы, которые лечатся входом', () => {
    expect(looksLikeAuthFailure('ERROR: [instagram] Requested content is not available, login required')).toBe(true);
    expect(looksLikeAuthFailure('Sign in to confirm you are not a bot')).toBe(true);
    expect(looksLikeAuthFailure('ERROR: This video is private')).toBe(true);
    expect(looksLikeAuthFailure('Video available to members only')).toBe(true);
    expect(looksLikeAuthFailure('HTTP Error 403: Forbidden')).toBe(true);
    expect(looksLikeAuthFailure('HTTP Error 401: Unauthorized')).toBe(true);
    expect(looksLikeAuthFailure('Use --cookies-from-browser or --cookies for the authentication')).toBe(true);
    expect(looksLikeAuthFailure('rate-limit reached or login required')).toBe(true);
    expect(looksLikeAuthFailure('This video is age-restricted')).toBe(true);
  });

  it('обычные поломки куками не лечатся — не гоняем сессию зря', () => {
    expect(looksLikeAuthFailure('ERROR: Unable to download webpage: timed out')).toBe(false);
    expect(looksLikeAuthFailure('HTTP Error 404: Not Found')).toBe(false);
    expect(looksLikeAuthFailure('ffmpeg exited with code 1')).toBe(false);
    expect(looksLikeAuthFailure('Unsupported URL')).toBe(false);
    expect(looksLikeAuthFailure('')).toBe(false);
    expect(looksLikeAuthFailure(undefined)).toBe(false);
  });

  it('регистр не важен: сообщения приходят как придётся', () => {
    expect(looksLikeAuthFailure('LOGIN REQUIRED')).toBe(true);
  });
});
