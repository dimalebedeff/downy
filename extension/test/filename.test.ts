import { describe, expect, it } from 'vitest';
import {
  buildFilename,
  buildYtdlpStem,
  extFromUrl,
  filenameFromUrl,
  localDateStamp,
  sanitizeFilename,
} from '../src/lib/filename';

// Фиксированная дата, чтобы тесты не зависели от календаря
const DATE = new Date(2026, 6, 10);

describe('sanitizeFilename', () => {
  it('заменяет запрещённые для Windows символы', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('схлопывает пробелы и убирает точки в конце', () => {
    expect(sanitizeFilename('  video   name... ')).toBe('video name');
  });

  it('не отдаёт пустое имя', () => {
    expect(sanitizeFilename('???')).toBe('video');
    expect(sanitizeFilename('')).toBe('video');
  });

  it('режет слишком длинные имена', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

describe('filenameFromUrl / extFromUrl', () => {
  it('достаёт имя файла из URL', () => {
    expect(filenameFromUrl('https://cdn.example.com/a/My%20Video.mp4?x=1')).toBe('My Video.mp4');
  });

  it('достаёт расширение', () => {
    expect(extFromUrl('https://cdn.example.com/clip.WebM?t=1')).toBe('webm');
    expect(extFromUrl('https://cdn.example.com/noext')).toBeNull();
  });
});

describe('localDateStamp', () => {
  it('локальная дата в формате YYYY-MM-DD', () => {
    expect(localDateStamp(DATE)).toBe('2026-07-10');
    expect(localDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('buildFilename', () => {
  it('заголовок страницы + качество + дата', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/master.m3u8', kind: 'hls', pageTitle: 'Мой фильм: часть 1' },
      '1080p',
      'both',
      DATE,
    );
    expect(name).toBe('Мой фильм часть 1 [1080p] [2026-07-10].mp4');
  });

  it('для прямых файлов берёт расширение из URL', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/clip.webm', kind: 'direct', pageTitle: 'Клип' },
      undefined,
      'both',
      DATE,
    );
    expect(name).toBe('Клип [2026-07-10].webm');
  });

  it('без заголовка пишет домен страницы, а не хеш из URL', () => {
    const name = buildFilename(
      { url: 'https://cdn07.example-cdn.net/4f3a2b7c9.mp4', kind: 'direct', pageUrl: 'https://www.vk.com/video123' },
      undefined,
      'both',
      DATE,
    );
    expect(name).toBe('Видео с vk.com [2026-07-10].mp4');
  });

  it('без заголовка и страницы — домен самого файла', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/4f3a2b7c9.mp4', kind: 'direct' },
      undefined,
      'both',
      DATE,
    );
    expect(name).toBe('Видео с cdn.example.com [2026-07-10].mp4');
  });

  it('аудио без заголовка — «Аудио с домен»', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/x.mp3', kind: 'direct', contentType: 'audio/mpeg' },
      undefined,
      'both',
      DATE,
    );
    expect(name).toBe('Аудио с cdn.example.com [2026-07-10].mp3');
  });

  it('для direct без расширения берёт его из Content-Type', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/stream', kind: 'direct', pageTitle: 'Аудио', contentType: 'audio/mpeg' },
      undefined,
      'both',
      DATE,
    );
    expect(name).toBe('Аудио [2026-07-10].mp3');
  });
});

describe('buildFilename с выбором дорожек', () => {
  const hls = { url: 'https://cdn.example.com/master.m3u8', kind: 'hls' as const, pageTitle: 'Фильм' };
  const mp4 = { url: 'https://cdn.example.com/clip.mp4', kind: 'direct' as const, pageTitle: 'Клип' };

  it('both не меняет имя', () => {
    expect(buildFilename(hls, '720p', 'both', DATE)).toBe('Фильм [720p] [2026-07-10].mp4');
  });

  it('hls только видео — пометка, контейнер mp4', () => {
    expect(buildFilename(hls, undefined, 'video', DATE)).toBe('Фильм [видео] [2026-07-10].mp4');
  });

  it('hls только аудио — контейнер m4a', () => {
    expect(buildFilename(hls, '720p', 'audio', DATE)).toBe('Фильм [720p] [аудио] [2026-07-10].m4a');
  });

  it('direct только видео сохраняет контейнер', () => {
    const webm = { ...mp4, url: 'https://cdn.example.com/clip.webm' };
    expect(buildFilename(webm, undefined, 'video', DATE)).toBe('Клип [видео] [2026-07-10].webm');
  });

  it('direct аудио из mp4 — m4a', () => {
    expect(buildFilename(mp4, undefined, 'audio', DATE)).toBe('Клип [аудио] [2026-07-10].m4a');
  });

  it('direct аудио из webm остаётся webm', () => {
    const webm = { ...mp4, url: 'https://cdn.example.com/clip.webm' };
    expect(buildFilename(webm, undefined, 'audio', DATE)).toBe('Клип [аудио] [2026-07-10].webm');
  });

  it('direct аудио из аудиофайла не меняет расширение', () => {
    const mp3 = { ...mp4, url: 'https://cdn.example.com/song.mp3' };
    expect(buildFilename(mp3, undefined, 'audio', DATE)).toBe('Клип [аудио] [2026-07-10].mp3');
  });

  it('dash ведёт себя как hls: mp4, аудио — m4a', () => {
    expect(buildFilename({ url: 'https://cdn.example.com/manifest.mpd', kind: 'dash' as const, pageTitle: 'Фильм' }, undefined, 'both', DATE))
      .toBe('Фильм [2026-07-10].mp4');
    expect(buildFilename({ url: 'https://cdn.example.com/manifest.mpd', kind: 'dash' as const, pageTitle: 'Фильм' }, undefined, 'audio', DATE))
      .toBe('Фильм [аудио] [2026-07-10].m4a');
  });
});

describe('buildYtdlpStem', () => {
  it('заголовок + качество + дата, без расширения', () => {
    expect(buildYtdlpStem('Мой ролик', 'https://youtube.com/watch?v=1', '1080p60', 'both', DATE))
      .toBe('Мой ролик [1080p60] [2026-07-10]');
  });

  it('метка дорожки при скачивании звука', () => {
    expect(buildYtdlpStem('Мой ролик', 'https://youtube.com/watch?v=1', undefined, 'audio', DATE))
      .toBe('Мой ролик [аудио] [2026-07-10]');
  });

  it('без заголовка — домен страницы', () => {
    expect(buildYtdlpStem(undefined, 'https://www.youtube.com/watch?v=1', undefined, 'both', DATE))
      .toBe('Видео с youtube.com [2026-07-10]');
  });

  it('чистит запрещённые символы', () => {
    expect(buildYtdlpStem('Кино: финал?', 'https://x.com/v', undefined, 'both', DATE))
      .toBe('Кино финал [2026-07-10]');
  });
});
