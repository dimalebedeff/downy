import type { HlsVariant } from './m3u8';
import type { MediaKind } from './media-detect';
import type { FileKind } from './media-icon';
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
  /** Под DRM: сегменты зашифрованы ключом лицензионного сервера. Скачать
   *  можно, смотреть нечего — обещать такую загрузку нечестно */
  drm?: boolean;
  /** Эфир: конца у потока нет, а длительность в манифесте — размер буфера */
  live?: boolean;
}

export interface JobInfo {
  jobId: string;
  label: string;
  /** Тип контента для иконки в списке — известен ещё до появления outFile */
  mediaKind?: FileKind;
  /** URL медиа (или страницы для yt-dlp) — по нему попап находит карточку загрузки */
  sourceUrl?: string;
  state: 'queued' | 'starting' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
  progress: number | null;
  /** Кто поставил паузу: юзер (ждёт ▶), вытеснение (продолжится само) или
   *  обрыв связи с хостом (тоже продолжится, но с оглядкой на счётчик) */
  pausedBy?: 'user' | 'preempt' | 'dropped';
  /** Сколько раз очередь уже поднимала эту загрузку после обрыва */
  autoResumes?: number;
  /** Мимо очереди (обложки): мелочь не должна ждать двухгиговое кино */
  noQueue?: boolean;
  bytes?: number;
  totalBytes?: number;
  /** Сглаженная скорость, байт/с — считает background по дельтам байтов */
  speedBps?: number;
  message?: string;
  outFile?: string;
  /** Когда загрузка закончилась (готово/ошибка/отмена) — для порядка и часов
   *  в списке завершённых */
  finishedAt?: number;
}
