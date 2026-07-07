import { describe, expect, it } from 'vitest';
import { canonicalMediaUrl, groupMediaItems } from '../src/lib/media-group';
import type { MediaItem } from '../src/lib/types';

const MB = 1024 * 1024;

function item(over: Partial<MediaItem> & { url: string }): MediaItem {
  return { kind: 'direct', tabId: 1, foundAt: 1, ...over };
}

describe('canonicalMediaUrl', () => {
  it('срезает параметры нарезки на куски (bytes, range и т.п.)', () => {
    expect(canonicalMediaUrl('https://vk.net/video.mp4?id=7&bytes=0-2488')).toBe('https://vk.net/video.mp4?id=7');
    expect(canonicalMediaUrl('https://cdn.io/v?itag=22&range=100-200&rn=5')).toBe('https://cdn.io/v?itag=22');
  });

  it('срезает hash и не трогает остальные параметры', () => {
    expect(canonicalMediaUrl('https://a.io/v.mp4?sig=x&expires=1#t=10')).toBe('https://a.io/v.mp4?sig=x&expires=1');
  });

  it('невалидный URL возвращает как есть', () => {
    expect(canonicalMediaUrl('not a url')).toBe('not a url');
  });
});

describe('groupMediaItems', () => {
  it('варианты одного видео (один host+path, разные параметры) сливаются в одну группу', () => {
    const items = [
      item({ url: 'https://vk.net/?id=7&type=0', size: 100 * MB, contentType: 'video/mp4' }),
      item({ url: 'https://vk.net/?id=7&type=2', size: 40 * MB, contentType: 'video/mp4' }),
      item({ url: 'https://vk.net/?id=7&type=3', size: 20 * MB, contentType: 'video/mp4' }),
    ];
    const groups = groupMediaItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.size).toBe(100 * MB); // лучшее качество — первым
    expect(groups[0].members).toHaveLength(3);
  });

  it('аудио и видео с одного адреса не сливаются', () => {
    const items = [
      item({ url: 'https://vk.net/?id=7&type=0', size: 100 * MB, contentType: 'video/mp4' }),
      item({ url: 'https://vk.net/?id=7&type=6', size: 5 * MB, contentType: 'audio/mp4' }),
    ];
    expect(groupMediaItems(items)).toHaveLength(2);
  });

  it('разные пути остаются отдельными пунктами', () => {
    const items = [
      item({ url: 'https://cdn.io/a.mp4', size: 10 * MB }),
      item({ url: 'https://cdn.io/b.mp4', size: 10 * MB }),
    ];
    expect(groupMediaItems(items)).toHaveLength(2);
  });

  it('мелкий мусор с известным размером отфильтровывается', () => {
    const items = [
      item({ url: 'https://ads.io/beep.mp3', size: 50 * 1024, contentType: 'audio/mpeg' }),
      item({ url: 'https://cdn.io/movie.mp4', size: 700 * MB }),
    ];
    const groups = groupMediaItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.url).toBe('https://cdn.io/movie.mp4');
  });

  it('элементы с неизвестным размером не считаются мусором', () => {
    const items = [item({ url: 'https://cdn.io/stream', contentType: 'video/mp4' })];
    expect(groupMediaItems(items)).toHaveLength(1);
  });

  it('HLS не группируется с direct и не фильтруется по размеру', () => {
    const items = [
      item({ url: 'https://cdn.io/master.m3u8', kind: 'hls' }),
      item({ url: 'https://cdn.io/master.m3u8?v=2', kind: 'hls' }),
    ];
    const groups = groupMediaItems(items);
    expect(groups.flatMap((g) => g.members)).toHaveLength(2);
  });

  it('порядок групп — по времени обнаружения первого элемента', () => {
    const items = [
      item({ url: 'https://b.io/late.mp4', foundAt: 5, size: 10 * MB }),
      item({ url: 'https://a.io/early.mp4', foundAt: 1, size: 10 * MB }),
    ];
    const groups = groupMediaItems(items);
    expect(groups[0].primary.url).toContain('early');
  });
});
