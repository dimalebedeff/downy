import { describe, expect, it } from 'vitest';
import { classifyMedia } from '../src/lib/media-detect';

describe('classifyMedia', () => {
  it('распознаёт прямые файлы по расширению', () => {
    expect(classifyMedia('https://cdn.example.com/video.mp4')).toBe('direct');
    expect(classifyMedia('https://cdn.example.com/a/b/clip.webm')).toBe('direct');
    expect(classifyMedia('https://cdn.example.com/song.mp3')).toBe('direct');
  });

  it('игнорирует query и hash после расширения', () => {
    expect(classifyMedia('https://cdn.example.com/video.mp4?token=abc&e=123')).toBe('direct');
    expect(classifyMedia('https://cdn.example.com/list.m3u8?sig=x#frag')).toBe('hls');
  });

  it('распознаёт по Content-Type, когда расширения нет', () => {
    expect(classifyMedia('https://cdn.example.com/stream', 'video/mp4')).toBe('direct');
    expect(classifyMedia('https://cdn.example.com/stream', 'application/vnd.apple.mpegurl')).toBe('hls');
    expect(classifyMedia('https://cdn.example.com/stream', 'application/x-mpegURL; charset=utf-8')).toBe('hls');
  });

  it('расширение побеждает octet-stream', () => {
    expect(classifyMedia('https://cdn.example.com/video.mp4', 'application/octet-stream')).toBe('direct');
  });

  it('не считает медиа сегменты стримов', () => {
    expect(classifyMedia('https://cdn.example.com/seg-001.ts')).toBeNull();
    expect(classifyMedia('https://cdn.example.com/chunk.m4s')).toBeNull();
    expect(classifyMedia('https://cdn.example.com/x', 'video/mp2t')).toBeNull();
  });

  it('не считает медиа обычные страницы и мусорные URL', () => {
    expect(classifyMedia('https://example.com/page.html', 'text/html')).toBeNull();
    expect(classifyMedia('not a url')).toBeNull();
    expect(classifyMedia('https://example.com/api/data', 'application/json')).toBeNull();
  });
});
