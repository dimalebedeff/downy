import { describe, expect, it } from 'vitest';
import { qualityOptions } from '../src/lib/ytdlp-formats';
import type { ProbeFormat } from '../../shared/protocol';

const MB = 1024 * 1024;

function video(height: number, over: Partial<ProbeFormat> = {}): ProbeFormat {
  return { height, hasVideo: true, hasAudio: false, ...over };
}

function audio(sizeBytes?: number): ProbeFormat {
  return { hasVideo: false, hasAudio: true, sizeBytes };
}

describe('qualityOptions', () => {
  it('схлопывает форматы по высоте, сортирует по убыванию', () => {
    const opts = qualityOptions([video(720), video(1080), video(720), video(360)]);
    expect(opts.map((o) => o.maxHeight)).toEqual([1080, 720, 360]);
    expect(opts.map((o) => o.label)).toEqual(['1080p', '720p', '360p']);
  });

  it('оценка веса: лучший видеоформат высоты + лучшее аудио', () => {
    const opts = qualityOptions([
      video(1080, { sizeBytes: 300 * MB }),
      video(1080, { sizeBytes: 200 * MB }),
      video(720, { sizeBytes: 100 * MB }),
      audio(50 * MB),
      audio(30 * MB),
    ]);
    expect(opts[0].label).toBe('1080p · ~350.0 МБ');
    expect(opts[1].label).toBe('720p · ~150.0 МБ');
  });

  it('муксованный формат (видео+звук) не добавляет аудио к весу', () => {
    const opts = qualityOptions([video(480, { hasAudio: true, sizeBytes: 80 * MB }), audio(50 * MB)]);
    expect(opts[0].label).toBe('480p · ~80.0 МБ');
  });

  it('60fps попадает в метку, дробный fps округляется', () => {
    const opts = qualityOptions([
      video(1080, { fps: 59.94 }),
      video(1080, { fps: 30 }),
      video(720, { fps: 25 }),
    ]);
    expect(opts[0].label).toBe('1080p60');
    expect(opts[1].label).toBe('720p');
  });

  it('без размера — метка без веса', () => {
    const opts = qualityOptions([video(720), audio(50 * MB)]);
    expect(opts[0].label).toBe('720p');
  });

  it('аудио-форматы и форматы без высоты не создают пунктов', () => {
    expect(qualityOptions([audio(50 * MB), { hasVideo: true, hasAudio: false }])).toEqual([]);
    expect(qualityOptions([])).toEqual([]);
  });
});
