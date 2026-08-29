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

/** Инлайновый SVG-путь (viewBox 0 0 24 24) для каждого типа — заливка currentColor */
const ICON_PATH: Record<FileKind, string> = {
  // Плёнка-рамка с треугольником play
  video: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 2v2h2V6H6zm10 0v2h2V6h-2zM6 16v2h2v-2H6zm10 0v2h2v-2h-2zm-6-6.5v5l4-2.5-4-2.5z',
  // Рамка с солнцем и горой
  image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm12 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 18h14l-4.5-6-3.5 4.5-2.5-3L5 18z',
  // Нота
  audio: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
  // Файл-документ (запасной)
  other: 'M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5z',
};

/** SVG-иконка типа, крашенная в фирменный жёлтый (класс .type-ic) */
export function typeIconSvg(kind: FileKind): string {
  return `<svg class="type-ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${ICON_PATH[kind]}"/></svg>`;
}
