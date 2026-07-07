import type { StreamSelection } from '../../../shared/protocol';

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
};

const FORBIDDEN_CHARS = new RegExp('[\\\\/:*?"<>|]|[\\u0000-\\u001f]', 'g');

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'video').slice(0, 120).trim();
}

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
  kind: 'direct' | 'hls';
  pageTitle?: string;
  contentType?: string;
}

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);

/** Контейнер для аудиодорожки, извлекаемой без перекодирования */
function audioExt(sourceExt: string): string {
  if (AUDIO_EXTS.has(sourceExt)) return sourceExt; // источник уже аудио
  if (sourceExt === 'webm' || sourceExt === 'mkv') return 'webm'; // opus/vorbis в m4a не лягут
  return 'm4a';
}

const STREAMS_LABEL: Record<StreamSelection, string> = { both: '', video: ' [видео]', audio: ' [аудио]' };

/** Имя файла с расширением: заголовок страницы (или имя из URL) + метка качества. */
export function buildFilename(item: FilenameSource, variantLabel?: string, streams: StreamSelection = 'both'): string {
  let base = item.pageTitle?.trim();
  if (!base) {
    const fromUrl = filenameFromUrl(item.url);
    base = fromUrl.replace(/\.[a-z0-9]{2,5}$/i, '') || 'video';
  }
  const suffix = (variantLabel ? ` [${variantLabel}]` : '') + STREAMS_LABEL[streams];
  let ext: string;
  if (item.kind === 'hls') {
    ext = streams === 'audio' ? 'm4a' : 'mp4';
  } else {
    const ct = (item.contentType ?? '').split(';')[0].trim().toLowerCase();
    ext = extFromUrl(item.url) ?? EXT_BY_TYPE[ct] ?? 'mp4';
    if (streams === 'audio') ext = audioExt(ext);
  }
  return `${sanitizeFilename(base + suffix)}.${ext}`;
}
