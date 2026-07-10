import { describe, expect, it } from 'vitest';
import { parseFfmpegMeta } from '../src/ffmeta';

const SAMPLE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:03:25.04, start: 0.000000, bitrate: 1205 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1067 kb/s, 25 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6D6134), 44100 Hz, stereo, fltp, 128 kb/s`;

describe('parseFfmpegMeta', () => {
  it('вытаскивает длительность и размеры', () => {
    expect(parseFfmpegMeta(SAMPLE)).toEqual({ durationSec: 205, width: 1920, height: 1080 });
  });
  it('аудио без видеопотока — только длительность', () => {
    const audio = 'Duration: 00:01:00.00, start: 0\n Stream #0:0: Audio: aac, 44100 Hz';
    expect(parseFfmpegMeta(audio)).toEqual({ durationSec: 60 });
  });
  it('мусор — пусто', () => {
    expect(parseFfmpegMeta('boom')).toEqual({});
  });
});
