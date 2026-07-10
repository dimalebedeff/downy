// Отрезок видео: разбор таймкодов из полей «от/до» и метка для имени файла.

import type { CutRange } from '../../../shared/protocol';

/** «90», «1:30», «1:05:20», допустимы десятые в секундах. Мусор — null. */
export function parseTimecode(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
  const parts = s.split(':');
  // Минуты и секунды в позиционной записи не бывают больше 59
  if (parts.length > 1 && parts.slice(1).some((p) => parseFloat(p) >= 60)) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/**
 * Маска поля времени: цифры заезжают справа в шаблон MM:SS — «1» → «00:01»,
 * «130» → «01:30»; от пятой цифры шаблон растёт до HH:MM:SS. Сплошные нули
 * равны пустому полю (пусто = «с начала» / «до конца»).
 */
export function maskTimecode(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '').slice(0, 6);
  if (!digits) return '';
  if (digits.length <= 4) {
    const p = digits.padStart(4, '0');
    return `${p.slice(0, 2)}:${p.slice(2)}`;
  }
  const p = digits.padStart(6, '0');
  return `${p.slice(0, 2)}:${p.slice(2, 4)}:${p.slice(4)}`;
}

/**
 * Отрезок из сырых полей ввода. null — просить нечего: оба поля пустые,
 * мусор в заполненном поле или конец не позже начала.
 */
export function makeCut(fromRaw: string, toRaw: string): CutRange | null {
  const from = parseTimecode(fromRaw);
  const to = parseTimecode(toRaw);
  if (fromRaw.trim() && from == null) return null;
  if (toRaw.trim() && to == null) return null;
  if (from == null && to == null) return null;
  if (from != null && to != null && to <= from) return null;
  return { fromSec: from ?? undefined, toSec: to ?? undefined };
}

/** «02.15-03.40» — двоеточия в именах файлов Windows запрещены */
export function cutLabel(cut: CutRange): string {
  const fmt = (sec: number): string => {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return h ? `${h}.${pad(m)}.${pad(s % 60)}` : `${pad(m)}.${pad(s % 60)}`;
  };
  const from = fmt(cut.fromSec ?? 0);
  const to = cut.toSec != null ? fmt(cut.toSec) : 'конец';
  return `${from}-${to}`;
}

/** Ютуб отдаёт SABR-потоки: yt-dlp --download-sections там виснет, а качать
 *  весь ролик ради отрезка — смысла нет. Пункт меню на ютубе гасим. */
export function isYoutubeUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

/** Вписывает метку отрезка в имя файла перед расширением */
export function withCutSuffix(filename: string, cut?: CutRange): string {
  if (!cut) return filename;
  const suffix = ` [${cutLabel(cut)}]`;
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) + suffix + filename.slice(dot) : filename + suffix;
}
