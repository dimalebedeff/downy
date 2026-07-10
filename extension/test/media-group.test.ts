import { describe, expect, it } from 'vitest';
import { FRESH_FIND_MS, canonicalMediaUrl, filterPageItems, groupMediaItems, samePage, sniffMuted, stripHash } from '../src/lib/media-group';
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

describe('stripHash', () => {
  it('срезает хэш плеера, query не трогает', () => {
    expect(stripHash('https://rezka.si/series/x.html#t:110-s:7-e:2')).toBe('https://rezka.si/series/x.html');
    expect(stripHash('https://a.io/watch?v=1#t=10')).toBe('https://a.io/watch?v=1');
  });

  it('мусорный URL возвращает как есть', () => {
    expect(stripHash('не-url')).toBe('не-url');
  });
});

describe('samePage', () => {
  it('одинаковые адреса с разным hash — одна страница', () => {
    expect(samePage('https://a.io/watch?v=1#t=10', 'https://a.io/watch?v=1')).toBe(true);
  });

  it('разный query — разные страницы (ютубовский /watch?v=)', () => {
    expect(samePage('https://a.io/watch?v=1', 'https://a.io/watch?v=2')).toBe(false);
  });

  it('пустые значения — не судим, отвечаем false', () => {
    expect(samePage(undefined, 'https://a.io/')).toBe(false);
    expect(samePage('https://a.io/', undefined)).toBe(false);
  });
});

describe('sniffMuted', () => {
  it('лента X — сниффер молчит', () => {
    expect(sniffMuted('https://x.com/home')).toBe(true);
    expect(sniffMuted('https://twitter.com/user/status/1')).toBe(true);
    expect(sniffMuted('https://www.x.com/home')).toBe(true);
  });

  it('обычные сайты — сниффер работает', () => {
    expect(sniffMuted('https://a.io/watch?v=1')).toBe(false);
    expect(sniffMuted('https://xx.com/')).toBe(false);
    expect(sniffMuted(undefined)).toBe(false);
    expect(sniffMuted('не-урл')).toBe(false);
  });
});

describe('filterPageItems', () => {
  const NOW = 10 * 60_000;

  it('оставляет медиа текущей страницы, отсекает старьё с прошлой', () => {
    const items = [
      item({ url: 'https://cdn.io/old.mp4', pageUrl: 'https://a.io/watch?v=old', foundAt: 0 }),
      item({ url: 'https://cdn.io/cur.mp4', pageUrl: 'https://a.io/watch?v=cur', foundAt: 0 }),
    ];
    const kept = filterPageItems(items, 'https://a.io/watch?v=cur', NOW);
    expect(kept.map((i) => i.url)).toEqual(['https://cdn.io/cur.mp4']);
  });

  it('свежую находку с чужим pageUrl не отсекает (гонка с префетчем)', () => {
    const items = [
      item({ url: 'https://cdn.io/next.mp4', pageUrl: 'https://a.io/watch?v=old', foundAt: NOW - FRESH_FIND_MS + 1000 }),
    ];
    expect(filterPageItems(items, 'https://a.io/watch?v=cur', NOW)).toHaveLength(1);
  });

  it('без pageUrl не судим — оставляем', () => {
    const items = [item({ url: 'https://cdn.io/x.mp4', foundAt: 0 })];
    expect(filterPageItems(items, 'https://a.io/', NOW)).toHaveLength(1);
  });

  it('hash в адресе вкладки не считается другой страницей', () => {
    const items = [item({ url: 'https://cdn.io/x.mp4', pageUrl: 'https://a.io/page', foundAt: 0 })];
    expect(filterPageItems(items, 'https://a.io/page#comments', NOW)).toHaveLength(1);
  });

  it('адрес вкладки неизвестен — показываем всё', () => {
    const items = [item({ url: 'https://cdn.io/x.mp4', pageUrl: 'https://a.io/other', foundAt: 0 })];
    expect(filterPageItems(items, undefined, NOW)).toHaveLength(1);
  });
});
