import { describe, expect, it } from 'vitest';
import { isPlaylistUrl, parseCommand, parseCutToken, parseTimecode } from '../src/parse';

describe('parseTimecode', () => {
  it('секунды', () => {
    expect(parseTimecode('85')).toBe(85);
  });
  it('мм:сс', () => {
    expect(parseTimecode('1:25')).toBe(85);
  });
  it('чч:мм:сс', () => {
    expect(parseTimecode('1:02:03')).toBe(3723);
  });
  it('мусор — null', () => {
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('1:99')).toBeNull();
  });
});

describe('parseCutToken', () => {
  it('полный отрезок', () => {
    expect(parseCutToken('1:20-2:45')).toEqual({ fromSec: 80, toSec: 165 });
  });
  it('секунды', () => {
    expect(parseCutToken('90-120')).toEqual({ fromSec: 90, toSec: 120 });
  });
  it('открытый конец', () => {
    expect(parseCutToken('1:20-')).toEqual({ fromSec: 80 });
  });
  it('открытое начало', () => {
    expect(parseCutToken('-2:45')).toEqual({ toSec: 165 });
  });
  it('конец раньше начала — null', () => {
    expect(parseCutToken('2:00-1:00')).toBeNull();
  });
  it('просто дефис — null', () => {
    expect(parseCutToken('-')).toBeNull();
  });
  it('не отрезок — null', () => {
    expect(parseCutToken('abc-def')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('голая ссылка', () => {
    expect(parseCommand('https://example.com/v/1')).toEqual({
      url: 'https://example.com/v/1',
      streams: 'both',
    });
  });
  it('ссылка + качество', () => {
    expect(parseCommand('https://example.com/v/1 720')).toEqual({
      url: 'https://example.com/v/1',
      streams: 'both',
      maxHeight: 720,
    });
  });
  it('качество с p', () => {
    expect(parseCommand('https://example.com/v/1 1080p')).toMatchObject({ maxHeight: 1080 });
  });
  it('audio', () => {
    expect(parseCommand('audio https://example.com/v/1')).toMatchObject({ streams: 'audio' });
    expect(parseCommand('https://example.com/v/1 аудио')).toMatchObject({ streams: 'audio' });
  });
  it('отрезок', () => {
    expect(parseCommand('https://example.com/v/1 1:20-2:45')).toMatchObject({
      cut: { fromSec: 80, toSec: 165 },
    });
  });
  it('всё сразу', () => {
    expect(parseCommand('https://example.com/v/1 720 audio 10-20')).toEqual({
      url: 'https://example.com/v/1',
      streams: 'audio',
      maxHeight: 720,
      cut: { fromSec: 10, toSec: 20 },
    });
  });
  it('нет ссылки — null', () => {
    expect(parseCommand('привет')).toBeNull();
    expect(parseCommand('/start')).toBeNull();
  });
  it('непонятный хвост — ошибка с подсказкой', () => {
    const r = parseCommand('https://example.com/v/1 фигня');
    expect(r).toHaveProperty('error');
  });
  it('кривое качество — ошибка', () => {
    const r = parseCommand('https://example.com/v/1 9999');
    expect(r).toHaveProperty('error');
  });
});

describe('isPlaylistUrl', () => {
  it('плейлист ютуба', () => {
    expect(isPlaylistUrl('https://www.youtube.com/playlist?list=PLx')).toBe(true);
  });
  it('видео из плейлиста — не плейлист (качаем само видео)', () => {
    expect(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=PLx')).toBe(false);
  });
  it('обычная ссылка', () => {
    expect(isPlaylistUrl('https://example.com/v/1')).toBe(false);
  });
});
