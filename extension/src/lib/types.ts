import type { HlsVariant } from './m3u8';

export interface MediaItem {
  /** Ключ — сам URL */
  url: string;
  kind: 'direct' | 'hls';
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
}

export interface JobInfo {
  jobId: string;
  label: string;
  state: 'starting' | 'running' | 'done' | 'error' | 'canceled';
  progress: number | null;
  message?: string;
  outFile?: string;
}
