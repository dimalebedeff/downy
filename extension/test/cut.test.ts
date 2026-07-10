import { describe, expect, it } from 'vitest';
import { cutLabel, isYoutubeUrl, makeCut, maskTimecode, parseTimecode, withCutSuffix } from '../src/lib/cut';

describe('parseTimecode', () => {
  it('голые секунды', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('0')).toBe(0);
  });

  it('мм:сс и чч:мм:сс', () => {
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('01:30')).toBe(90);
    expect(parseTimecode('1:05:20')).toBe(3920);
  });

  it('десятые секунды', () => {
    expect(parseTimecode('1:30.5')).toBe(90.5);
  });

  it('пробелы по краям не мешают', () => {
    expect(parseTimecode(' 1:30 ')).toBe(90);
  });

  it('мусор и пустота — null', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:99')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('-5')).toBeNull();
  });
});

describe('maskTimecode', () => {
  it('цифры заезжают справа в шаблон MM:SS', () => {
    expect(maskTimecode('1')).toBe('00:01');
    expect(maskTimecode('13')).toBe('00:13');
    expect(maskTimecode('130')).toBe('01:30');
    expect(maskTimecode('1305')).toBe('13:05');
  });

  it('от пятой цифры шаблон растёт до HH:MM:SS, седьмая игнорируется', () => {
    expect(maskTimecode('13:059')).toBe('01:30:59');
    expect(maskTimecode('130520')).toBe('13:05:20');
    expect(maskTimecode('13:05:209')).toBe('13:05:20');
  });

  it('нецифры выкидываются, нули и пустота — пустое поле', () => {
    expect(maskTimecode('a1b3c0')).toBe('01:30');
    expect(maskTimecode('')).toBe('');
    expect(maskTimecode('0')).toBe('');
    expect(maskTimecode('00:00')).toBe('');
  });

  it('backspace уменьшает число справа', () => {
    // Было «00:13», стёрли последний символ → «00:1» → «00:01»
    expect(maskTimecode('00:1')).toBe('00:01');
  });
});

describe('makeCut', () => {
  it('оба поля — полный отрезок', () => {
    expect(makeCut('1:30', '2:45')).toEqual({ fromSec: 90, toSec: 165 });
  });

  it('пустое «от» — с начала, пустое «до» — до конца', () => {
    expect(makeCut('', '2:45')).toEqual({ fromSec: undefined, toSec: 165 });
    expect(makeCut('1:30', '')).toEqual({ fromSec: 90, toSec: undefined });
  });

  it('оба пустые или мусор — null', () => {
    expect(makeCut('', '')).toBeNull();
    expect(makeCut('abc', '2:45')).toBeNull();
    expect(makeCut('1:30', 'xyz')).toBeNull();
  });

  it('конец не позже начала — null', () => {
    expect(makeCut('2:45', '1:30')).toBeNull();
    expect(makeCut('1:30', '1:30')).toBeNull();
  });
});

describe('cutLabel', () => {
  it('минуты и секунды с точками — двоеточия Windows не переварит', () => {
    expect(cutLabel({ fromSec: 90, toSec: 165 })).toBe('01.30-02.45');
  });

  it('часы, начало по умолчанию, открытый конец', () => {
    expect(cutLabel({ fromSec: 3920, toSec: 4000 })).toBe('1.05.20-1.06.40');
    expect(cutLabel({ toSec: 60 })).toBe('00.00-01.00');
    expect(cutLabel({ fromSec: 90 })).toBe('01.30-конец');
  });
});

describe('isYoutubeUrl', () => {
  it('ютуб во всех обличиях', () => {
    expect(isYoutubeUrl('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isYoutubeUrl('https://youtu.be/x')).toBe(true);
    expect(isYoutubeUrl('https://music.youtube.com/watch?v=x')).toBe(true);
  });

  it('не ютуб', () => {
    expect(isYoutubeUrl('https://x.com/user/status/1')).toBe(false);
    expect(isYoutubeUrl('https://notyoutube.com/')).toBe(false);
    expect(isYoutubeUrl(undefined)).toBe(false);
    expect(isYoutubeUrl('мусор')).toBe(false);
  });
});

describe('withCutSuffix', () => {
  it('метка встаёт перед расширением', () => {
    expect(withCutSuffix('video.mp4', { fromSec: 90, toSec: 165 })).toBe('video [01.30-02.45].mp4');
  });

  it('без расширения — в хвост; без отрезка — как было', () => {
    expect(withCutSuffix('video', { fromSec: 90 })).toBe('video [01.30-конец]');
    expect(withCutSuffix('video.mp4', undefined)).toBe('video.mp4');
  });
});
