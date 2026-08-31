import { describe, expect, it } from 'vitest';
import { unsupportedReason } from '../src/lib/unsupported';

describe('unsupportedReason', () => {
  it('мессенджеры с шифрованием объясняются каждый по-своему', () => {
    expect(unsupportedReason('https://web.whatsapp.com/')).toMatch(/шифрует/);
    expect(unsupportedReason('https://web.telegram.org/k/#123')).toMatch(/мимо браузера/);
  });

  it('подписки с защитой контента', () => {
    expect(unsupportedReason('https://www.netflix.com/watch/81234567')).toMatch(/под защитой/);
    expect(unsupportedReason('https://hd.kinopoisk.ru/film/abc')).toMatch(/под защитой/);
    expect(unsupportedReason('https://okko.tv/movie/x')).toMatch(/под защитой/);
  });

  it('музыкальные стриминги', () => {
    expect(unsupportedReason('https://open.spotify.com/track/abc')).toMatch(/только своему плееру/);
    expect(unsupportedReason('https://music.yandex.ru/album/1')).toMatch(/только своему плееру/);
  });

  it('обычные площадки работают как всегда', () => {
    expect(unsupportedReason('https://x.com/user/status/1')).toBeNull();
    expect(unsupportedReason('https://youtube.com/watch?v=a')).toBeNull();
    expect(unsupportedReason('https://eda.yandex.ru/')).toBeNull();
  });

  it('чужой домен с похожим хвостом не путаем', () => {
    // Похожее имя — не повод сдаваться: правило должно смотреть на границу
    expect(unsupportedReason('https://notnetflix.com/watch/1')).toBeNull();
    expect(unsupportedReason('https://fake-ivi.ru/video/1')).toBeNull();
  });

  it('поддомен настоящего сервиса всё же считается', () => {
    expect(unsupportedReason('https://www.ivi.ru/watch/123')).toMatch(/под защитой/);
  });

  it('мусор вместо адреса не роняет', () => {
    expect(unsupportedReason('')).toBeNull();
    expect(unsupportedReason('не адрес')).toBeNull();
  });
});
