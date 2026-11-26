import { describe, expect, it } from 'vitest';
import {
  isTelegramMediaUrl,
  isTelegramWeb,
  parseContentRange,
  telegramFileInfo,
  telegramStem,
} from '../src/lib/telegram';

const kStream = (data: object): string =>
  `https://web.telegram.org/k/stream/${encodeURIComponent(JSON.stringify(data))}`;

describe('isTelegramMediaUrl', () => {
  it('поток плеера Web K и Web A', () => {
    expect(isTelegramMediaUrl(kStream({ dcId: 2, size: 10 }))).toBe(true);
    expect(isTelegramMediaUrl('https://web.telegram.org/a/progressive/document5123?fileSize=10')).toBe(true);
  });

  it('blob из вкладки Telegram — да, из чужой — нет', () => {
    expect(isTelegramMediaUrl('blob:https://web.telegram.org/0b6f-11')).toBe(true);
    expect(isTelegramMediaUrl('blob:https://x.com/0b6f-11')).toBe(false);
  });

  it('обычные адреса Telegram и чужие сайты не трогаем', () => {
    expect(isTelegramMediaUrl('https://web.telegram.org/k/#@durov')).toBe(false);
    expect(isTelegramMediaUrl('https://evil.com/k/stream/x')).toBe(false);
    expect(isTelegramMediaUrl('https://notweb.telegram.org.evil.com/a/progressive/x')).toBe(false);
    expect(isTelegramMediaUrl(undefined)).toBe(false);
  });

  it('сам сайт узнаём по хосту', () => {
    expect(isTelegramWeb('https://web.telegram.org/a/#-100123')).toBe(true);
    expect(isTelegramWeb('https://telegram.org/')).toBe(false);
  });
});

describe('telegramFileInfo', () => {
  it('Web K: размер, тип и имя из JSON в пути', () => {
    expect(telegramFileInfo(kStream({ size: 12345, mimeType: 'video/mp4', fileName: 'clip.mp4' }))).toEqual({
      size: 12345,
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
    });
  });

  it('Web A: то же из параметров', () => {
    expect(
      telegramFileInfo('https://web.telegram.org/a/progressive/document1?fileSize=999&mimeType=video%2Fquicktime'),
    ).toEqual({ size: 999, mimeType: 'video/quicktime' });
  });

  it('битый JSON и blob не роняют', () => {
    expect(telegramFileInfo('https://web.telegram.org/k/stream/%7Bbroken')).toEqual({});
    expect(telegramFileInfo('blob:https://web.telegram.org/abc')).toEqual({});
  });
});

describe('parseContentRange', () => {
  it('разбирает кусок и полный размер', () => {
    expect(parseContentRange('bytes 0-524287/10485760')).toEqual({ start: 0, end: 524287, total: 10485760 });
  });
  it('неизвестный полный размер и мусор', () => {
    expect(parseContentRange('bytes 10-20/*')).toEqual({ start: 10, end: 20, total: undefined });
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('items 1-2')).toBeNull();
  });
});

describe('telegramStem', () => {
  it('имя документа сохраняем с его расширением', () => {
    expect(telegramStem({ fileName: 'Лекция 3.MOV' }, 'video')).toEqual({ stem: 'Лекция 3', ext: 'mov' });
  });
  it('безымянное: расширение по типу, имя — откуда', () => {
    expect(telegramStem({ mimeType: 'video/webm' }, 'video')).toEqual({ stem: 'Видео из Telegram', ext: 'webm' });
    expect(telegramStem({}, 'image')).toEqual({ stem: 'Фото из Telegram', ext: 'jpg' });
  });
});
