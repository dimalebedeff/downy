import { describe, expect, it } from 'vitest';
import { buildFilename, extFromUrl, filenameFromUrl, sanitizeFilename } from '../src/lib/filename';

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

describe('buildFilename', () => {
  it('использует заголовок страницы и метку качества', () => {
    const name = buildFilename(
      { url: 'https://cdn.example.com/master.m3u8', kind: 'hls', pageTitle: 'Мой фильм: часть 1' },
      '1080p',
    );
    expect(name).toBe('Мой фильм часть 1 [1080p].mp4');
  });

  it('для прямых файлов берёт расширение из URL', () => {
    const name = buildFilename({ url: 'https://cdn.example.com/clip.webm', kind: 'direct', pageTitle: 'Клип' });
    expect(name).toBe('Клип.webm');
  });

  it('без заголовка берёт имя из URL', () => {
    const name = buildFilename({ url: 'https://cdn.example.com/funny-cat.mp4', kind: 'direct' });
    expect(name).toBe('funny-cat.mp4');
  });

  it('для direct без расширения берёт его из Content-Type', () => {
    const name = buildFilename({
      url: 'https://cdn.example.com/stream',
      kind: 'direct',
      pageTitle: 'Аудио',
      contentType: 'audio/mpeg',
    });
    expect(name).toBe('Аудио.mp3');
  });
});

describe('buildFilename с выбором дорожек', () => {
  const hls = { url: 'https://cdn.example.com/master.m3u8', kind: 'hls' as const, pageTitle: 'Фильм' };
  const mp4 = { url: 'https://cdn.example.com/clip.mp4', kind: 'direct' as const, pageTitle: 'Клип' };

  it('both не меняет имя', () => {
    expect(buildFilename(hls, '720p', 'both')).toBe('Фильм [720p].mp4');
  });

  it('hls только видео — пометка, контейнер mp4', () => {
    expect(buildFilename(hls, undefined, 'video')).toBe('Фильм [видео].mp4');
  });

  it('hls только аудио — контейнер m4a', () => {
    expect(buildFilename(hls, '720p', 'audio')).toBe('Фильм [720p] [аудио].m4a');
  });

  it('direct только видео сохраняет контейнер', () => {
    const webm = { ...mp4, url: 'https://cdn.example.com/clip.webm' };
    expect(buildFilename(webm, undefined, 'video')).toBe('Клип [видео].webm');
  });

  it('direct аудио из mp4 — m4a', () => {
    expect(buildFilename(mp4, undefined, 'audio')).toBe('Клип [аудио].m4a');
  });

  it('direct аудио из webm остаётся webm', () => {
    const webm = { ...mp4, url: 'https://cdn.example.com/clip.webm' };
    expect(buildFilename(webm, undefined, 'audio')).toBe('Клип [аудио].webm');
  });

  it('direct аудио из аудиофайла не меняет расширение', () => {
    const mp3 = { ...mp4, url: 'https://cdn.example.com/song.mp3' };
    expect(buildFilename(mp3, undefined, 'audio')).toBe('Клип [аудио].mp3');
  });

  it('dash ведёт себя как hls: mp4, аудио — m4a', () => {
    const dash = { url: 'https://cdn.example.com/manifest.mpd', kind: 'dash' as const, pageTitle: 'Фильм' };
    expect(buildFilename(dash)).toBe('Фильм.mp4');
    expect(buildFilename(dash, undefined, 'audio')).toBe('Фильм [аудио].m4a');
  });
});
