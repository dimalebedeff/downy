// Что внутри файла — по выводу `ffmpeg -i`. Имя врёт: сайты кладут рядом с
// роликом немой десятисекундный «preview», и по адресу их не различить.
// Содержимое не врёт, а заголовок читается по сети за доли секунды.

export interface ProbedMedia {
  url: string;
  /** Файл открылся и в нём есть хоть одна дорожка */
  ok: boolean;
  hasAudio?: boolean;
  hasVideo?: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
}

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const VIDEO_STREAM = /Stream #\d+:\d+[^\n]*:\s*Video:[^\n]*/g;
const AUDIO_STREAM = /Stream #\d+:\d+[^\n]*:\s*Audio:/;
/** Размер кадра в строке потока: «540x960», но не «[SAR 1:1 DAR 9:16]» */
const FRAME = /\b(\d{2,5})x(\d{2,5})\b/;

/** Что ffmpeg рассказал о файле: дорожки, длительность, размер кадра */
export function parseFfmpegInfo(output: string): Omit<ProbedMedia, 'url'> {
  const video = output.match(VIDEO_STREAM) ?? [];
  const hasVideo = video.length > 0;
  const hasAudio = AUDIO_STREAM.test(output);
  if (!hasVideo && !hasAudio) return { ok: false };

  let durationSec: number | undefined;
  const d = DURATION.exec(output);
  if (d) {
    const sec = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    // N/A превращается в 0 — такую длительность лучше считать неизвестной
    if (sec > 0) durationSec = sec;
  }

  let width: number | undefined;
  let height: number | undefined;
  for (const line of video) {
    const f = FRAME.exec(line);
    if (!f) continue;
    const w = Number(f[1]);
    const h = Number(f[2]);
    if (w * h > (width ?? 0) * (height ?? 0)) {
      width = w;
      height = h;
    }
  }

  return { ok: true, hasVideo, hasAudio, durationSec, width, height };
}

