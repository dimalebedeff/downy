// Скачивает ffmpeg.exe и yt-dlp.exe в coapp/bin.
// Запуск: npm run coapp:fetch-bins

import { execSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { nextSpeed, renderLine } from './download-progress.mjs';

const coappDir = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(coappDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

/** Живая перерисовка одной строки; молча выходит, если stdout — не терминал */
function makeReporter(name, total) {
  const tty = process.stdout.isTTY;
  let track;
  let lastDraw = 0;
  const paint = (downloaded, force) => {
    const now = Date.now();
    if (!force && now - lastDraw < 150) return;
    lastDraw = now;
    track = nextSpeed(track, downloaded, now);
    const line = renderLine({ name, downloaded, total, speedBps: track?.bps });
    if (tty) process.stdout.write(`\r${line}\x1b[K`);
  };
  return {
    tick: (downloaded) => paint(downloaded, false),
    done: (downloaded) => {
      paint(downloaded, true);
      if (tty) process.stdout.write('\n');
    },
  };
}

async function download(url, dest) {
  const name = path.basename(dest);
  console.log(`Скачиваю ${name}…`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} для ${url}`);

  const total = Number(resp.headers.get('content-length')) || 0;
  const reporter = makeReporter(name, total);
  const out = fs.createWriteStream(dest);
  let downloaded = 0;
  try {
    for await (const chunk of Readable.fromWeb(resp.body)) {
      downloaded += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      reporter.tick(downloaded);
    }
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  reporter.done(downloaded);
  if (!process.stdout.isTTY) {
    console.log(`  -> ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} МБ)`);
  }
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
