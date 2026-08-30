import { describe, expect, it } from 'vitest';
import { parseFfmpegInfo } from '../../shared/ffmpeg-info';
import { pickBestMedia, type ProbedMedia } from '../src/lib/media-probe';

// Живой вывод ffmpeg по озоновским файлам — на них и вылез немой огрызок
const PREVIEW = `
  Duration: 00:00:10.50, start: 0.000000, bitrate: 357 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 360x640 [SAR 1:1 DAR 9:16], 353 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
`;
const FULL_720 = `
  Duration: 00:00:32.80, start: 0.000000, bitrate: 1243 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 720x1280 [SAR 1:1 DAR 9:16], 1143 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 90 kb/s (default)
`;
const AUDIO_ONLY = `
  Duration: 00:03:12.04, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
`;
const NOT_MEDIA = `
  https://site.com/page.html: Invalid data found when processing input
`;

describe('parseFfmpegInfo', () => {
  it('видит немое превью: видео есть, звука нет', () => {
    const info = parseFfmpegInfo(PREVIEW);
    expect(info.ok).toBe(true);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(false);
    expect(info.durationSec).toBeCloseTo(10.5, 1);
    expect(info.width).toBe(360);
    expect(info.height).toBe(640);
  });

  it('видит полный ролик со звуком', () => {
    const info = parseFfmpegInfo(FULL_720);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(32.8, 1);
    expect(info.width).toBe(720);
    expect(info.height).toBe(1280);
  });

  it('размер кадра не путается с соотношением сторон', () => {
    // В строке есть «[SAR 1:1 DAR 9:16]» — это не разрешение
    expect(parseFfmpegInfo(FULL_720).height).not.toBe(16);
  });

  it('аудиофайл без картинки — тоже годный файл', () => {
    const info = parseFfmpegInfo(AUDIO_ONLY);
    expect(info.ok).toBe(true);
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(192.04, 1);
  });

  it('не медиа — не годится', () => {
    expect(parseFfmpegInfo(NOT_MEDIA).ok).toBe(false);
    expect(parseFfmpegInfo('').ok).toBe(false);
  });

  it('часы в длительности считаются', () => {
    expect(parseFfmpegInfo('Duration: 01:02:03.00\n Stream #0:0: Video: h264, 100x100').durationSec).toBe(3723);
  });
});

describe('pickBestMedia', () => {
  const at = (url: string, p: Partial<ProbedMedia>): ProbedMedia => ({ url, ok: true, ...p });

  it('звук важнее чёткости: немой 4K проигрывает озвученному 540p', () => {
    const best = pickBestMedia([
      at('mute-4k', { hasAudio: false, durationSec: 33, width: 3840, height: 2160 }),
      at('sound-540', { hasAudio: true, durationSec: 33, width: 540, height: 960 }),
    ]);
    expect(best?.url).toBe('sound-540');
  });

  it('обрезок проигрывает полному ролику', () => {
    const best = pickBestMedia([
      at('preview', { hasAudio: false, durationSec: 10.5, width: 360, height: 640 }),
      at('full', { hasAudio: true, durationSec: 32.8, width: 720, height: 1280 }),
    ]);
    expect(best?.url).toBe('full');
  });

  it('одинаковый ролик в разном качестве — берём чётче', () => {
    const best = pickBestMedia([
      at('asset_0', { hasAudio: true, durationSec: 32.8, width: 360, height: 640 }),
      at('asset_2', { hasAudio: true, durationSec: 32.8, width: 720, height: 1280 }),
      at('asset_1', { hasAudio: true, durationSec: 32.8, width: 540, height: 960 }),
    ]);
    expect(best?.url).toBe('asset_2');
  });

  it('секунда разницы — то же видео, решает качество', () => {
    const best = pickBestMedia([
      at('hi', { hasAudio: true, durationSec: 32.8, width: 1280, height: 720 }),
      at('lo', { hasAudio: true, durationSec: 33.2, width: 640, height: 360 }),
    ]);
    expect(best?.url).toBe('hi');
  });

  it('нерабочие кандидаты выбрасываются', () => {
    const best = pickBestMedia([
      { url: 'broken', ok: false },
      at('good', { hasAudio: true, durationSec: 10, width: 320, height: 240 }),
    ]);
    expect(best?.url).toBe('good');
  });

  it('годных нет вовсе — ничего не возвращаем', () => {
    expect(pickBestMedia([{ url: 'a', ok: false }])).toBeUndefined();
    expect(pickBestMedia([])).toBeUndefined();
  });

  it('известная длительность лучше неизвестной', () => {
    const best = pickBestMedia([
      at('unknown', { hasAudio: true, width: 1920, height: 1080 }),
      at('known', { hasAudio: true, durationSec: 20, width: 640, height: 360 }),
    ]);
    expect(best?.url).toBe('known');
  });
});
