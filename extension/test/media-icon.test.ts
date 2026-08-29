import { describe, expect, it } from 'vitest';
import { mediaKindFromFile } from '../src/lib/media-icon';

describe('mediaKindFromFile', () => {
  it('видео по расширению', () => {
    expect(mediaKindFromFile('clip.mp4')).toBe('video');
    expect(mediaKindFromFile('movie.MKV')).toBe('video');
    expect(mediaKindFromFile('C:\\Users\\me\\Downloads\\a.webm')).toBe('video');
  });

  it('картинка по расширению', () => {
    expect(mediaKindFromFile('cover.jpg')).toBe('image');
    expect(mediaKindFromFile('thumb.PNG')).toBe('image');
    expect(mediaKindFromFile('/home/u/pic.webp')).toBe('image');
  });

  it('аудио по расширению', () => {
    expect(mediaKindFromFile('song.mp3')).toBe('audio');
    expect(mediaKindFromFile('track.m4a')).toBe('audio');
    expect(mediaKindFromFile('voice.opus')).toBe('audio');
  });

  it('неизвестное и пустое — other', () => {
    expect(mediaKindFromFile('archive.zip')).toBe('other');
    expect(mediaKindFromFile('noext')).toBe('other');
    expect(mediaKindFromFile('')).toBe('other');
    expect(mediaKindFromFile(undefined)).toBe('other');
    expect(mediaKindFromFile('.env')).toBe('other');
  });

  it('берёт последнее расширение у имени с точками', () => {
    expect(mediaKindFromFile('my.video.final.mp4')).toBe('video');
  });
});
