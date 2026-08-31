import { describe, expect, it } from 'vitest';
import { classifyYtdlpError, explainYtdlpError } from '../src/lib/ytdlp-errors';

describe('classifyYtdlpError', () => {
  it('вход на сайт', () => {
    expect(classifyYtdlpError('ERROR: [instagram] Requested content is not available, login required')).toBe('auth');
    expect(classifyYtdlpError("Sign in to confirm you're not a bot")).toBe('auth');
    expect(classifyYtdlpError('ERROR: This video is private')).toBe('auth');
    expect(classifyYtdlpError('HTTP Error 403: Forbidden')).toBe('auth');
  });

  it('движок JavaScript — то, на чём мы горели двое суток', () => {
    expect(classifyYtdlpError('No supported JavaScript runtime could be found')).toBe('js-runtime');
    expect(classifyYtdlpError('ERROR: [youtube] abc: The page needs to be reloaded.')).toBe('js-runtime');
    expect(classifyYtdlpError('Ensure you have a supported JavaScript runtime ... refer to EJS')).toBe('js-runtime');
  });

  it('сайт ограничил частоту', () => {
    expect(classifyYtdlpError('HTTP Error 429: Too Many Requests')).toBe('rate-limit');
  });

  it('сайт незнаком экстрактору', () => {
    expect(classifyYtdlpError('ERROR: Unsupported URL: https://example.com/x')).toBe('unsupported');
    expect(classifyYtdlpError('ERROR: Unable to extract player version')).toBe('unsupported');
  });

  it('мы сами передали неизвестный флаг', () => {
    expect(classifyYtdlpError('yt-dlp.exe: error: no such option: --js-runtimes')).toBe('cli');
  });

  it('сеть', () => {
    expect(classifyYtdlpError('ERROR: Unable to download webpage: timed out')).toBe('network');
  });

  it('чего не узнали — то и не выдумываем', () => {
    expect(classifyYtdlpError('ERROR: что-то совсем новое')).toBe('unknown');
    expect(classifyYtdlpError('')).toBe('unknown');
    expect(classifyYtdlpError(undefined)).toBe('unknown');
  });

  it('вход важнее частоты: ютуб отдаёт 429 заодно с бот-чеком', () => {
    // В логах эти строки приходят вместе, и лечится это входом, а не паузой
    const both = 'WARNING: HTTP Error 429: Too Many Requests\nERROR: Sign in to confirm you are not a bot';
    expect(classifyYtdlpError(both)).toBe('auth');
  });
});

describe('explainYtdlpError', () => {
  it('вход нужен, а cookies выключены — зовём в настройки', () => {
    const hint = explainYtdlpError({ message: 'login required', cookiesOn: false });
    expect(hint).toMatch(/cookies/i);
    expect(hint).toMatch(/настройк/i);
  });

  it('cookies уже отправляли — в настройки звать бессмысленно', () => {
    const hint = explainYtdlpError({ message: 'login required', cookiesOn: true, cookiesTried: true });
    expect(hint).toMatch(/вошли/i);
    expect(hint).not.toMatch(/включите/i);
  });

  it('вход нужен, cookies включены, попытка ещё впереди — молчим', () => {
    expect(explainYtdlpError({ message: 'login required', cookiesOn: true })).toBeNull();
  });

  it('каждый распознанный класс объясняется, и объяснение говорит, что делать', () => {
    const cases = [
      'No supported JavaScript runtime could be found',
      'HTTP Error 429: Too Many Requests',
      'ERROR: Unsupported URL: https://example.com/x',
      'yt-dlp.exe: error: no such option: --js-runtimes',
      'ERROR: Unable to download webpage: timed out',
    ];
    for (const message of cases) {
      const hint = explainYtdlpError({ message, cookiesOn: false });
      expect(hint, message).toBeTruthy();
      expect(hint!.length, message).toBeGreaterThan(20);
    }
  });

  it('незнакомую ругань не пересказываем: покажем как есть', () => {
    expect(explainYtdlpError({ message: 'ERROR: что-то совсем новое', cookiesOn: false })).toBeNull();
  });
});
