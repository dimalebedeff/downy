import type { HlsVariant } from './m3u8';
import type { MediaKind } from './media-detect';

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
  state: 'starting' | 'running' | 'done' | 'error' | 'canceled';
  progress: number | null;
  bytes?: number;
  totalBytes?: number;
  message?: string;
  outFile?: string;
}
