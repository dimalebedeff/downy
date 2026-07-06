import { describe, expect, it } from 'vitest';
import {
  isMasterPlaylist,
  looksLikePlaylist,
  parseMasterPlaylist,
  playlistDuration,
  variantLabel,
} from '../src/lib/m3u8';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
https://cdn.example.com/hls/mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
high/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.5,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXTINF:4.25,
seg3.ts
#EXT-X-ENDLIST
`;

describe('looksLikePlaylist / isMasterPlaylist', () => {
  it('отличает плейлист от не-плейлиста', () => {
    expect(looksLikePlaylist(MASTER)).toBe(true);
    expect(looksLikePlaylist('<html></html>')).toBe(false);
  });

  it('отличает мастер от медиа-плейлиста', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(isMasterPlaylist(MEDIA)).toBe(false);
  });
});

describe('parseMasterPlaylist', () => {
  const variants = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');

  it('находит все варианты и сортирует по битрейту (лучший первым)', () => {
    expect(variants).toHaveLength(3);
    expect(variants[0].label).toBe('1080p');
    expect(variants[1].label).toBe('720p');
    expect(variants[2].label).toBe('360p');
  });

  it('резолвит относительные URL против базового', () => {
    expect(variants[0].url).toBe('https://cdn.example.com/hls/high/index.m3u8');
    expect(variants[1].url).toBe('https://cdn.example.com/hls/mid/index.m3u8');
  });

  it('переживает CODECS с запятой внутри кавычек', () => {
    expect(variants[2].codecs).toBe('avc1.4d401e,mp4a.40.2');
    expect(variants[2].bandwidth).toBe(800000);
  });
});

describe('variantLabel', () => {
  it('строит метку из разрешения, иначе из битрейта', () => {
    expect(variantLabel('1920x1080', 5000000)).toBe('1080p');
    expect(variantLabel(undefined, 1500000)).toBe('1500 kbps');
    expect(variantLabel(undefined, undefined)).toBe('поток');
  });
});

describe('playlistDuration', () => {
  it('суммирует EXTINF', () => {
    expect(playlistDuration(MEDIA)).toBe(24);
  });

  it('возвращает 0, если сегментов нет', () => {
    expect(playlistDuration(MASTER)).toBe(0);
  });
});
