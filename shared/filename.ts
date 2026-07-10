// Общие правила имён файлов — нужны и расширению, и боту.

const FORBIDDEN_CHARS = new RegExp('[\\\\/:*?"<>|]|[\\u0000-\\u001f]', 'g');

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'video').slice(0, 120).trim();
}

/** Локальная дата скачивания для имени файла: 2026-07-10 */
export function localDateStamp(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
