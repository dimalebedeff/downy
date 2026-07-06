export type MediaKind = 'direct' | 'hls';

const DIRECT_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const HLS_EXT = /\.m3u8$/i;
// Сегменты стримов — не самостоятельное медиа, их не показываем.
const SEGMENT_EXT = /\.(ts|m4s|m2ts|init)$/i;

const DIRECT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-m4v',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/mpegurl',
]);

const SEGMENT_TYPES = new Set(['video/mp2t', 'video/iso.segment']);

/** Классифицирует URL (+ Content-Type, если известен) как медиа или нет. */
export function classifyMedia(url: string, contentType?: string | null): MediaKind | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();

  if (SEGMENT_TYPES.has(ct) || SEGMENT_EXT.test(pathname)) return null;
  if (HLS_TYPES.has(ct) || HLS_EXT.test(pathname)) return 'hls';
  if (DIRECT_TYPES.has(ct) || DIRECT_EXT.test(pathname)) return 'direct';
  return null;
}
