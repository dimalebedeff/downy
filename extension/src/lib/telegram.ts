/**
 * Telegram Web: медиа, которые живут только внутри вкладки.
 *
 * Telegram качает файлы своим протоколом, а видео отдаёт плееру через
 * собственный service worker по адресам вида `/k/stream/{...}` (Web K) и
 * `/a/progressive/document123` (Web A). Снаружи вкладки таких адресов нет —
 * ни CoApp, ни yt-dlp их не откроют. Зато сама вкладка читает их как обычный
 * файл, с Range, даже в каналах, где сохранение запрещено: запрет там
 * прячет кнопку, а не данные. Поэтому читаем изнутри страницы и кусками
 * отдаём помощнику.
 */

const TG_HOST = /(^|\.)web\.telegram\.org$/;

export function isTelegramWeb(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return TG_HOST.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Адрес, который откроет только вкладка Telegram: поток плеера или blob */
export function isTelegramMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  // blob:https://web.telegram.org/uuid — origin сидит внутри
  if (url.startsWith('blob:')) return isTelegramWeb(url.slice(5));
  if (!isTelegramWeb(url)) return false;
  try {
    return /\/(stream|progressive)\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface TelegramFileInfo {
  size?: number;
  mimeType?: string;
  fileName?: string;
}

/**
 * Что адрес знает о файле сам. Web K прячет в пути JSON с размером, типом и
 * иногда именем; Web A кладёт то же в параметры запроса.
 */
export function telegramFileInfo(url: string): TelegramFileInfo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  const info: TelegramFileInfo = {};
  const k = u.pathname.match(/\/stream\/(.+)$/);
  if (k) {
    try {
      const data = JSON.parse(decodeURIComponent(k[1])) as Record<string, unknown>;
      if (typeof data.size === 'number' && data.size > 0) info.size = data.size;
      if (typeof data.mimeType === 'string') info.mimeType = data.mimeType;
      if (typeof data.fileName === 'string' && data.fileName.trim()) info.fileName = data.fileName.trim();
    } catch {
      // формат пути поменялся — обойдёмся тем, что скажет сам ответ
    }
    return info;
  }
  const size = Number(u.searchParams.get('fileSize'));
  if (size > 0) info.size = size;
  const mime = u.searchParams.get('mimeType');
  if (mime) info.mimeType = mime;
  const name = u.searchParams.get('fileName');
  if (name?.trim()) info.fileName = name.trim();
  return info;
}

/** `bytes 0-524287/10485760` → начало, конец, полный размер */
export function parseContentRange(
  header: string | null | undefined,
): { start: number; end: number; total?: number } | null {
  const m = header?.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return null;
  const total = m[3] === '*' ? undefined : Number(m[3]);
  return { start: Number(m[1]), end: Number(m[2]), total };
}

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/**
 * Имя без даты и защиты от перезаписи — их добавит общий buildFilename и
 * хост. Своё имя у файла есть только у документов; фото и ролики из канала
 * безымянны, и тогда пишем хотя бы, откуда они.
 */
export function telegramStem(info: TelegramFileInfo, kind: 'image' | 'video'): { stem: string; ext: string } {
  const fromName = info.fileName?.match(/^(.*?)\.([a-z0-9]{2,5})$/i);
  const ext =
    (fromName?.[2].toLowerCase()) ??
    (info.mimeType ? EXT_BY_MIME[info.mimeType.split(';')[0].trim().toLowerCase()] : undefined) ??
    (kind === 'image' ? 'jpg' : 'mp4');
  const stem = fromName?.[1].trim() || info.fileName || (kind === 'image' ? 'Фото из Telegram' : 'Видео из Telegram');
  return { stem, ext };
}

/** Сколько байт отдаём за раз: мегабайт — и сообщение лёгкое, и круговоротов немного */
export const PAGE_CHUNK_BYTES = 1024 * 1024;
