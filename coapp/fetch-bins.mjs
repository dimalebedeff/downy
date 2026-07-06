// Скачивает ffmpeg.exe и yt-dlp.exe в coapp/bin.
// Запуск: npm run coapp:fetch-bins

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const coappDir = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(coappDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

async function download(url, dest) {
  console.log(`Скачиваю ${url}`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} для ${url}`);
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(dest));
  console.log(`  -> ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} МБ)`);
}

function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

// yt-dlp — один exe
const ytdlpDest = path.join(binDir, 'yt-dlp.exe');
if (fs.existsSync(ytdlpDest)) {
  console.log('yt-dlp.exe уже есть, пропускаю');
} else {
  await download(YTDLP_URL, ytdlpDest);
}

// ffmpeg — zip, достаём ffmpeg.exe
const ffmpegDest = path.join(binDir, 'ffmpeg.exe');
if (fs.existsSync(ffmpegDest)) {
  console.log('ffmpeg.exe уже есть, пропускаю');
} else {
  const zipPath = path.join(binDir, 'ffmpeg.zip');
  const tmpDir = path.join(binDir, 'ffmpeg-tmp');
  await download(FFMPEG_ZIP_URL, zipPath);
  console.log('Распаковываю ffmpeg…');
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`,
    { stdio: 'inherit' },
  );
  const found = findFileRecursive(tmpDir, 'ffmpeg.exe');
  if (!found) throw new Error('ffmpeg.exe не найден в архиве');
  fs.copyFileSync(found, ffmpegDest);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  console.log(`  -> ${ffmpegDest}`);
}

console.log('Готово.');
