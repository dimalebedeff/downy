import type { HlsVariant } from './m3u8';
import type { MediaKind } from './media-detect';
import type { ProbeFormat } from '../../../shared/protocol';

/** Состояние разведки форматов страницы (yt-dlp -J), кешируется в фоне */
export type ProbeState =
  | { status: 'pending' }
  | { status: 'ready'; title?: string; thumbnailUrl?: string; formats: ProbeFormat[] }
  | { status: 'error'; error?: string };

export interface MediaItem {
  /** Ключ — сам URL */
  url: string;
  kind: MediaKind;
  tabId: number;
  foundAt: number;
  contentType?: string;
  /** Полный размер файла в байтах, если известен */
  size?: number;
  pageUrl?: string;
  pageTitle?: string;
  /** Для HLS-мастера — варианты качества */
  variants?: HlsVariant[];
  /** Для HLS-медиаплейлиста — длительность в секундах */
  durationSec?: number;
  /** Превью: poster тега video или кадр (data URL) */
  thumb?: string;
}

export interface JobInfo {
  jobId: string;
  label: string;
  /** URL медиа (или страницы для yt-dlp) — по нему попап находит карточку загрузки */
  sourceUrl?: string;
  state: 'queued' | 'starting' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
  progress: number | null;
  /** Кто поставил паузу: юзер (ждёт ▶) или вытеснение (продолжится само) */
  pausedBy?: 'user' | 'preempt';
  /** Мимо очереди (обложки): мелочь не должна ждать двухгиговое кино */
  noQueue?: boolean;
  bytes?: number;
  totalBytes?: number;
  /** Сглаженная скорость, байт/с — считает background по дельтам байтов */
  speedBps?: number;
  message?: string;
  outFile?: string;
}
