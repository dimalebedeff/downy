// Разбор сообщения боту: ссылка + необязательные модификаторы
// («720», «audio», отрезок «1:20-2:45») в любом порядке.

import type { CutRange, StreamSelection } from '../../shared/protocol';

export interface Command {
  url: string;
  streams: StreamSelection;
  maxHeight?: number;
  cut?: CutRange;
}

export interface ParseError {
  error: string;
}

const KNOWN_HEIGHTS = new Set([144, 240, 360, 480, 720, 1080, 1440, 2160, 4320]);
const AUDIO_WORDS = new Set(['audio', 'аудио', 'звук', 'mp3', 'm4a']);

/** «85», «1:25», «1:02:03» → секунды; мусор → null */
export function parseTimecode(s: string): number | null {
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** «A-B», «A-», «-B» → отрезок; не отрезок → null */
export function parseCutToken(s: string): CutRange | null {
  const m = s.match(/^([\d:]*)-([\d:]*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  const cut: CutRange = {};
  if (m[1]) {
    const from = parseTimecode(m[1]);
    if (from == null) return null;
    cut.fromSec = from;
  }
  if (m[2]) {
    const to = parseTimecode(m[2]);
    if (to == null) return null;
    cut.toSec = to;
  }
  if (cut.fromSec != null && cut.toSec != null && cut.toSec <= cut.fromSec) return null;
  return cut;
}

/**
 * Текст сообщения → команда. null — ссылки нет вообще (не команда),
 * ParseError — ссылка есть, но рядом непонятные слова.
 */
export function parseCommand(text: string): Command | ParseError | null {
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!urlMatch) return null;
  const url = urlMatch[0].replace(/[>),.]+$/, '');

  const cmd: Command = { url, streams: 'both' };
  const rest = (text.slice(0, urlMatch.index) + ' ' + text.slice(urlMatch.index! + urlMatch[0].length)).trim();
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (AUDIO_WORDS.has(lower)) {
      cmd.streams = 'audio';
      continue;
    }
    const height = lower.match(/^(\d{3,4})p?$/);
    if (height) {
      const h = Number(height[1]);
      if (!KNOWN_HEIGHTS.has(h)) return { error: `Не понял качество «${token}». Могу так: 480, 720, 1080, 1440, 2160.` };
      cmd.maxHeight = h;
      continue;
    }
    if (token.includes('-')) {
      const cut = parseCutToken(token);
      if (!cut) return { error: `Не понял отрезок «${token}». Формат: 1:20-2:45, 90-120, 1:20- или -2:45.` };
      cmd.cut = cut;
      continue;
    }
    return { error: `Не понял «${token}». Умею: ссылка, качество (720), audio, отрезок (1:20-2:45).` };
  }
  return cmd;
}

/** Ссылка на плейлист целиком (а не на видео из плейлиста) */
export function isPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.includes('/playlist');
  } catch {
    return false;
  }
}
