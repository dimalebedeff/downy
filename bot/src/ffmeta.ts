// Метаданные скачанного файла через `ffmpeg -i` (ffprobe в bin не тянем):
// длительность и размеры кадра нужны Telegram, чтобы видео играло инлайн.

import { spawn } from 'node:child_process';

export interface VideoMeta {
  durationSec?: number;
  width?: number;
  height?: number;
}

/** Парсер stderr `ffmpeg -i`: Duration и WxH видеопотока */
export function parseFfmpegMeta(stderr: string): VideoMeta {
  const meta: VideoMeta = {};
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) meta.durationSec = Math.round(Number(dur[1]) * 3600 + Number(dur[2]) * 60 + parseFloat(dur[3]));
  const dim = stderr.match(/Stream .*Video:.*?\s(\d{2,5})x(\d{2,5})/);
  if (dim) {
    meta.width = Number(dim[1]);
    meta.height = Number(dim[2]);
  }
  return meta;
}

export function probeVideoMeta(ffmpegPath: string, file: string): Promise<VideoMeta> {
  return new Promise((resolve) => {
    // Без выходного файла ffmpeg выходит с кодом 1 — это норма, читаем stderr
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
    });
    child.on('error', () => resolve({}));
    child.on('close', () => resolve(parseFfmpegMeta(err)));
  });
}
