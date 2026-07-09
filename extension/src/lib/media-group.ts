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

/**
 * Свежие находки показываем даже при несовпадении pageUrl: медиа следующего
 * ролика SPA часто детектится до смены адреса и штампуется старой страницей.
 */
export const FRESH_FIND_MS = 2 * 60_000;

/** Один ли это адрес страницы (hash не считается: #comment — та же страница). */
export function samePage(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.toString() === ub.toString();
  } catch {
    return a === b;
  }
}

/**
 * Отсекает находки с прошлых страниц SPA: показываем медиа текущего адреса
 * вкладки, без pageUrl (не по чему судить) и свежее FRESH_FIND_MS.
 */
export function filterPageItems(items: MediaItem[], currentUrl?: string, now = Date.now()): MediaItem[] {
  if (!currentUrl) return items;
  return items.filter(
    (it) => !it.pageUrl || samePage(it.pageUrl, currentUrl) || now - it.foundAt < FRESH_FIND_MS,
  );
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
    // Стримы не группируем: у HLS варианты качества уже внутри элемента,
    // у DASH качества выбирает yt-dlp
    const key = item.kind !== 'direct' ? `${item.kind}|${item.url}` : groupKey(item);
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
