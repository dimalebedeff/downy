import { localDateStamp, sanitizeFilename } from '../../../shared/filename';
import type { StreamSelection } from '../../../shared/protocol';

export { localDateStamp, sanitizeFilename };

const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function filenameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(base) || 'video';
  } catch {
    return 'video';
  }
}

export function extFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface FilenameSource {
  url: string;
  kind: 'direct' | 'hls' | 'dash';
  pageUrl?: string;
  pageTitle?: string;
  contentType?: string;
}

/** Хеши из CDN-ссылок в имени не нужны — пишем хотя бы откуда скачано */
function domainBase(pageUrl: string | undefined, url: string, isAudio: boolean): string {
  let host = '';
  try {
    host = new URL(pageUrl || url).hostname.replace(/^www\./, '');
  } catch {
    // битый URL — останется просто «Видео»
  }
  const noun = isAudio ? 'Аудио' : 'Видео';
  return host ? `${noun} с ${host}` : noun;
}

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);

/** Контейнер для аудиодорожки, извлекаемой без перекодирования */
function audioExt(sourceExt: string): string {
  if (AUDIO_EXTS.has(sourceExt)) return sourceExt; // источник уже аудио
  if (sourceExt === 'webm' || sourceExt === 'mkv') return 'webm'; // opus/vorbis в m4a не лягут
  return 'm4a';
}

const STREAMS_LABEL: Record<StreamSelection, string> = { both: '', video: ' [видео]', audio: ' [аудио]' };

/** Имя файла с расширением: «Название [качество] [дорожка] [дата].ext». */
export function buildFilename(
  item: FilenameSource,
  variantLabel?: string,
  streams: StreamSelection = 'both',
  date: Date = new Date(),
): string {
  const ct = (item.contentType ?? '').split(';')[0].trim().toLowerCase();
  const base =
    item.pageTitle?.trim() ||
    domainBase(item.pageUrl, item.url, item.kind === 'direct' && ct.startsWith('audio'));
  const suffix = (variantLabel ? ` [${variantLabel}]` : '') + STREAMS_LABEL[streams] + ` [${localDateStamp(date)}]`;
  let ext: string;
  if (item.kind !== 'direct') {
    // Стримы (HLS/DASH) всегда склеиваются в mp4/m4a
    ext = streams === 'audio' ? 'm4a' : 'mp4';
  } else {
    ext = extFromUrl(item.url) ?? EXT_BY_TYPE[ct] ?? 'mp4';
    if (streams === 'audio') ext = audioExt(ext);
  }
  return `${sanitizeFilename(base + suffix)}.${ext}`;
}

/** Имя без расширения для yt-dlp: контейнер подберёт хост. */
export function buildYtdlpStem(
  pageTitle: string | undefined,
  pageUrl: string,
  qualityLabel: string | undefined,
  streams: StreamSelection = 'both',
  date: Date = new Date(),
): string {
  const base = pageTitle?.trim() || domainBase(pageUrl, pageUrl, false);
  const suffix = (qualityLabel ? ` [${qualityLabel}]` : '') + STREAMS_LABEL[streams] + ` [${localDateStamp(date)}]`;
  return sanitizeFilename(base + suffix);
}
