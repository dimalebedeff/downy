export interface HlsVariant {
  url: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  /** Человекочитаемая метка качества: «1080p», «1500 kbps» */
  label: string;
}

export function looksLikePlaylist(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U');
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF');
}

/** Разбирает список атрибутов HLS: KEY=VALUE,KEY="v,alue",... */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

export function variantLabel(resolution?: string, bandwidth?: number): string {
  if (resolution) {
    const m = resolution.match(/x(\d+)/i);
    return m ? `${m[1]}p` : resolution;
  }
  if (bandwidth) return `${Math.round(bandwidth / 1000)} kbps`;
  return 'поток';
}

export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand || cand.startsWith('#')) continue;
      uri = cand;
      i = j;
      break;
    }
    if (!uri) continue;
    const bandwidth = attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : undefined;
    const resolution = attrs.RESOLUTION;
    variants.push({
      url: resolveUrl(uri, baseUrl),
      bandwidth,
      resolution,
      codecs: attrs.CODECS,
      label: variantLabel(resolution, bandwidth),
    });
  }
  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  return variants;
}

/** Суммарная длительность медиа-плейлиста в секундах (0, если не посчитать). */
export function playlistDuration(text: string): number {
  let total = 0;
  const re = /#EXTINF:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) total += parseFloat(m[1]);
  return Math.round(total);
}

function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}
