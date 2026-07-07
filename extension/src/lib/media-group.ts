// Очистка списка медиа: канонизация «нарезанных» URL, фильтр мусора,
// группировка вариантов одного видео (качества) в один пункт.

import type { MediaItem } from './types';
import { isProbablyVideo } from './media-detect';

/**
 * Параметры, которыми сайты нарезают один файл на куски (range-запросы через
 * query). Срезаем их, чтобы куски одного видео схлопывались в один элемент,
 * а скачивание по такому URL отдавало файл целиком.
 */
const CHUNK_PARAMS = new Set([
  'range', 'bytes', 'byterange', 'rn', 'rbuf', 'sq', 'sn',
  'seg', 'segment', 'frag', 'fragment', 'start', 'end', 'offset',
  'startbyte', 'endbyte',
]);

export function canonicalMediaUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const name of [...u.searchParams.keys()]) {
      if (CHUNK_PARAMS.has(name.toLowerCase())) u.searchParams.delete(name);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Меньше этого (при известном размере) — скорее всего рекламный джингл/огрызок */
const MIN_SIZE_BYTES = 300 * 1024;

function isJunk(item: MediaItem): boolean {
  if (item.kind !== 'direct') return false;
  return item.size != null && item.size > 0 && item.size < MIN_SIZE_BYTES;
}

function mediaClass(item: MediaItem): string {
  const major = item.contentType?.split('/')[0].trim().toLowerCase();
  if (major === 'video' || major === 'audio') return major;
  return isProbablyVideo(item.url, item.contentType) ? 'video' : 'media';
}

function groupKey(item: MediaItem): string {
  try {
    const u = new URL(item.url);
    return `${mediaClass(item)}|${u.host}${u.pathname}`;
  } catch {
    return `${mediaClass(item)}|${item.url}`;
  }
}

export interface MediaGroup {
  /** Лучший (самый большой) вариант — его показываем в строке списка */
  primary: MediaItem;
  /** Все варианты группы, отсортированы по размеру по убыванию */
  members: MediaItem[];
}

export function groupMediaItems(items: MediaItem[]): MediaGroup[] {
  const groups = new Map<string, MediaItem[]>();
  const order: string[] = [];
  const sorted = items.slice().sort((a, b) => a.foundAt - b.foundAt);
  for (const item of sorted) {
    if (isJunk(item)) continue;
    // HLS не группируем: варианты качества уже внутри самого элемента
    const key = item.kind === 'hls' ? `hls|${item.url}` : groupKey(item);
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(item);
  }
  return order.map((key) => {
    const members = groups.get(key)!.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    return { primary: members[0], members };
  });
}
