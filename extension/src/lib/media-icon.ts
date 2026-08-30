// Тип скачанного файла по расширению — для иконки в списке загрузок.

export type FileKind = 'video' | 'image' | 'audio' | 'other';

const VIDEO = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'flv', 'ts', 'm2ts', 'ogv', '3gp']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'weba']);

/** Расширение файла/пути в нижнем регистре без точки; '' если его нет */
function ext(nameOrPath: string): string {
  const base = nameOrPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // нет точки или скрытый файл вида «.env»
  return base.slice(dot + 1).toLowerCase();
}

/** Класс медиа по имени файла или полному пути; неизвестное — 'other' */
export function mediaKindFromFile(nameOrPath: string | undefined): FileKind {
  const e = ext(nameOrPath ?? '');
  if (!e) return 'other';
  if (VIDEO.has(e)) return 'video';
  if (IMAGE.has(e)) return 'image';
  if (AUDIO.has(e)) return 'audio';
  return 'other';
}

// Внутренность SVG (viewBox 0 0 24 24) на каждый тип. fill/stroke заданы
// прямо на элементах — CSS их не перекрашивает (иначе рамки заливаются).
const ICON_INNER: Record<FileKind, string> = {
  // Скруглённая рамка + play — в духе логотипа YouTube
  video:
    '<rect x="2" y="5" width="20" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M10 8.7v6.6l5.5-3.3z" fill="currentColor"/>',
  // Рамка + солнце + гора
  image:
    '<rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="8" cy="9.5" r="1.7" fill="currentColor"/>' +
    '<path d="M4 18l4.5-5 3 3.2L15 12l5 6z" fill="currentColor"/>',
  // Нота
  audio: '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" fill="currentColor"/>',
  // Лист-документ (запасной)
  other: '<path d="M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5z" fill="currentColor"/>',
};

/** SVG-иконка типа; цвет берётся из currentColor контейнера (.type-icon) */
export function typeIconSvg(kind: FileKind): string {
  return `<svg class="type-ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${ICON_INNER[kind]}</svg>`;
}
