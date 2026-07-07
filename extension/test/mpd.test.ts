import { describe, expect, it } from 'vitest';
import { looksLikeMpd, mpdDuration } from '../src/lib/mpd';

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT1H2M3.5S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('looksLikeMpd', () => {
  it('узнаёт манифест', () => {
    expect(looksLikeMpd(MPD)).toBe(true);
    expect(looksLikeMpd('  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">')).toBe(true);
  });

  it('отвергает не-манифесты', () => {
    expect(looksLikeMpd('<html><body>404</body></html>')).toBe(false);
    expect(looksLikeMpd('#EXTM3U')).toBe(false);
    expect(looksLikeMpd('')).toBe(false);
  });
});

describe('mpdDuration', () => {
  it('парсит ISO 8601-длительность', () => {
    expect(mpdDuration(MPD)).toBeCloseTo(3723.5);
  });

  it('минуты и секунды без часов', () => {
    expect(mpdDuration('<MPD mediaPresentationDuration="PT4M13S">')).toBe(253);
    expect(mpdDuration('<MPD mediaPresentationDuration="PT47.36S">')).toBeCloseTo(47.36);
  });

  it('live-манифест без длительности — null', () => {
    expect(mpdDuration('<MPD type="dynamic">')).toBeNull();
  });
});
