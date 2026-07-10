import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  binWorks,
  cleanupPartials,
  createYtdlpEngine,
  HLS_CONCURRENCY,
  killProcessTree,
  makeYtdlpStdoutHandler,
  uniquePath,
  YTDLP_COMMON_ARGS,
} from '../../shared/ytdlp';
import { readMessages, sendMessage } from './nm';
import type {
  CoAppRequest,
  CutRange,
  DirectJobRequest,
  HlsJobRequest,
  JobEvent,
  PickDirRequest,
  ProbeRequest,
  StreamSelection,
  ThumbnailJobRequest,
  ThumbRequest,
  UpdateRequest,
  YtdlpJobRequest,
} from '../../shared/protocol';

// Держи в синхроне с extension/manifest.json и package.json
const VERSION = '0.10.0';

// __dirname указывает на coapp/dist после сборки
const coappRoot = path.join(__dirname, '..');
const binDir = path.join(coappRoot, 'bin');
const logFile = path.join(coappRoot, 'coapp.log');

function log(...args: unknown[]): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
  } catch {
    // лог не критичен
  }
}

const engine = createYtdlpEngine({ binDir, log });
const { ffmpegPath, ytdlpPath } = engine;

const defaultOutDir = path.join(os.homedir(), 'Downloads', 'downy');

function resolveOutDir(requested?: string): string {
  const dir = requested?.trim() || defaultOutDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface RunningJob {
  canceled: boolean;
  /** Пауза: процесс убиваем, но недокачанное оставляем для резюма */
  paused: boolean;
  kill(): void;
}

const jobs = new Map<string, RunningJob>();

function processJob(child: ChildProcess): RunningJob {
  return {
    canceled: false,
    paused: false,
    kill: () => killProcessTree(child),
  };
}

function emit(event: JobEvent): void {
  sendMessage(event);
}

function jobDone(
  jobId: string,
  code: number | null,
  flags: { canceled: boolean; paused?: boolean },
  outFile: string,
  errTail: string,
  pausedKeepsFile = true,
): void {
  jobs.delete(jobId);
  if (flags.paused) {
    // outFile в событии = «есть что докачивать»; без него резюм начнёт сначала
    if (pausedKeepsFile) {
      emit({ type: 'job', jobId, state: 'paused', progress: null, outFile });
    } else {
      fs.rm(outFile, { force: true }, () => {});
      emit({ type: 'job', jobId, state: 'paused', progress: null });
    }
  } else if (flags.canceled) {
    fs.rm(outFile, { force: true }, () => {});
    emit({ type: 'job', jobId, state: 'canceled', progress: null });
  } else if (code === 0) {
    emit({ type: 'job', jobId, state: 'done', progress: 1, outFile });
  } else {
    emit({ type: 'job', jobId, state: 'error', progress: null, message: errTail.slice(-500) || `exit code ${code}` });
  }
}

/** Прогресс yt-dlp → событие job для расширения */
function ytdlpProgressToEmit(jobId: string): (p: { progress: number; bytes?: number; totalBytes?: number }) => void {
  return (p) => emit({ type: 'job', jobId, state: 'running', progress: p.progress, bytes: p.bytes, totalBytes: p.totalBytes });
}

function startHls(req: HlsJobRequest): void {
  const streams = req.streams ?? 'both';
  let outFile: string;
  try {
    if (req.resumePath) {
      // Докачка после паузы: тот же файл, yt-dlp сам продолжит .part
      outFile = req.resumePath;
    } else {
      const outDir = resolveOutDir(req.outDir);
      const wantExt = streams === 'audio' ? '.m4a' : '.mp4';
      const filename = req.filename.toLowerCase().endsWith(wantExt) ? req.filename : `${req.filename}${wantExt}`;
      outFile = uniquePath(outDir, filename);
    }
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  // yt-dlp качает сегменты параллельно и обходит троттлинг на одно соединение;
  // ffmpeg (последовательный) — фолбэк и путь для отрезков: -ss пропускает
  // сегменты до начала, качается только нужный кусок
  if (engine.ytdlpWorks() && !req.cut) startHlsYtdlp(req, outFile, streams);
  else startFfmpegCopy(req, outFile, streams);
}

function startHlsYtdlp(req: HlsJobRequest, outFile: string, streams: StreamSelection): void {
  // Дорожку вырезаем после скачивания: в муксованном HLS yt-dlp не умеет
  // отдать только видео/аудио, а качать медленным ffmpeg напрямую — терять скорость
  const dlFile = streams === 'both' ? outFile : `${outFile}.dl.mp4`;
  const args = [...YTDLP_COMMON_ARGS, '--no-playlist', '--concurrent-fragments', HLS_CONCURRENCY, '-o', dlFile];
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  if (req.headers?.userAgent) args.push('--user-agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('--referer', req.headers.referer);
  args.push(req.url);

  log('yt-dlp hls start', req.jobId, req.url, '->', outFile, 'streams:', streams);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let errTail = '';
  child.stdout?.on('data', makeYtdlpStdoutHandler(ytdlpProgressToEmit(req.jobId)));
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  // При ошибке спавна срабатывают и 'error', и 'close' — фолбэк должен быть один
  let settled = false;
  const fallback = (reason: string): void => {
    if (settled) return;
    settled = true;
    log('yt-dlp hls fallback to ffmpeg', req.jobId, reason.slice(-300));
    jobs.delete(req.jobId);
    cleanupPartials(dlFile);
    startFfmpegCopy(req, outFile, streams);
  };

  child.on('error', (e) => {
    fallback(`spawn error: ${e.message}`);
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    log('yt-dlp hls exit', req.jobId, code, 'canceled:', job.canceled, 'paused:', job.paused);
    if (job.paused) {
      // Хвосты .part остаются на диске — по ним yt-dlp продолжит
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, outFile });
    } else if (job.canceled) {
      jobs.delete(req.jobId);
      cleanupPartials(dlFile);
      emit({ type: 'job', jobId: req.jobId, state: 'canceled', progress: null });
    } else if (code === 0) {
      if (streams === 'both') jobDone(req.jobId, code, job, outFile, errTail);
      else stripTracks(req.jobId, dlFile, outFile, streams);
    } else {
      fallback(errTail);
    }
  });
}

/** Копирует из скачанного файла только выбранную дорожку (без перекодирования). */
function stripTracks(jobId: string, srcFile: string, outFile: string, streams: 'video' | 'audio'): void {
  // Отмена могла прийти в зазор между выходом yt-dlp и этим вызовом —
  // тогда она осела в уже завершившемся джобе
  if (jobs.get(jobId)?.canceled) {
    jobs.delete(jobId);
    try {
      fs.rmSync(srcFile, { force: true });
    } catch {
      // временный файл не критичен
    }
    emit({ type: 'job', jobId, state: 'canceled', progress: null });
    return;
  }
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', srcFile];
  args.push('-map', streams === 'video' ? '0:v' : '0:a', '-c', 'copy');
  if (/\.(mp4|m4a|mov)$/i.test(outFile)) args.push('-movflags', '+faststart');
  args.push(outFile);

  log('strip start', jobId, srcFile, '->', outFile);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  // Отмена с этого момента должна убивать ffmpeg, а не завершившийся yt-dlp
  const job = processJob(child);
  jobs.set(jobId, job);

  let errTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  let settled = false;
  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    // Синхронно: после jobDone хост могут закрыть, и хвост останется на диске
    try {
      fs.rmSync(srcFile, { force: true });
    } catch {
      // временный файл не критичен
    }
    log('strip exit', jobId, code, 'canceled:', job.canceled);
    // Вырезка дорожки — быстрая локальная операция, пауза к ней не применяется
    jobDone(jobId, code, { canceled: job.canceled }, outFile, errTail);
  };
  child.on('error', (e) => {
    errTail = `Не удалось запустить ffmpeg: ${e.message}`;
    finish(1);
  });
  child.on('close', finish);
}

interface FfmpegCopySource {
  jobId: string;
  url: string;
  cut?: CutRange;
  headers?: { referer?: string; userAgent?: string };
}

function startFfmpegCopy(req: FfmpegCopySource, outFile: string, streams: StreamSelection): void {
  const args = ['-y', '-nostdin', '-hide_banner'];
  if (req.headers?.userAgent) args.push('-user_agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('-referer', req.headers.referer);
  // -ss до -i — быстрый пропуск до ключевого кадра, без чтения всего начала
  if (req.cut?.fromSec) args.push('-ss', String(req.cut.fromSec));
  args.push('-i', req.url);
  if (streams === 'video') args.push('-map', '0:v');
  else if (streams === 'audio') args.push('-map', '0:a');
  args.push('-c', 'copy');
  const cutDur = req.cut?.toSec != null ? req.cut.toSec - (req.cut.fromSec ?? 0) : undefined;
  if (cutDur && cutDur > 0) args.push('-t', String(cutDur));
  if (/\.(mp4|m4a|mov)$/i.test(outFile)) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', outFile);

  log('ffmpeg start', req.jobId, req.url, '->', outFile);
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let durationSec: number | null = null;
  let errTail = '';
  let lastSent = 0;

  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    errTail = (errTail + s).slice(-2000);
    if (durationSec == null) {
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
    }
  });

  let writtenBytes = 0;
  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    const sizeMatch = s.match(/total_size=(\d+)/);
    if (sizeMatch) writtenBytes = Number(sizeMatch[1]);
    const timeMatch = s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    let progress: number | null = null;
    if (timeMatch && durationSec) {
      const done = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      // out_time считает выход (уже относительно начала отрезка) — шкалу
      // меряем длиной отрезка, а не всего ролика
      const from = req.cut?.fromSec ?? 0;
      const end = req.cut?.toSec != null ? Math.min(req.cut.toSec, durationSec) : durationSec;
      const total = end - from;
      if (total > 0) progress = Math.min(0.999, done / total);
    }
    emit({
      type: 'job',
      jobId: req.jobId,
      state: 'running',
      progress,
      bytes: writtenBytes || undefined,
    });
  });

  child.on('error', (e) => {
    jobs.delete(req.jobId);
    log('ffmpeg spawn error', e.message);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить ffmpeg: ${e.message}` });
  });

  child.on('close', (code) => {
    log('ffmpeg exit', req.jobId, code, 'canceled:', job.canceled, 'paused:', job.paused);
    // Обрубленный ffmpeg-файл не докачивается — пауза здесь = начать заново
    jobDone(req.jobId, code, job, outFile, errTail, false);
  });
}

async function startDirect(req: DirectJobRequest): Promise<void> {
  let outFile: string;
  let startBytes = 0;
  try {
    if (req.resumePath) {
      // Докачка после паузы: продолжаем тот же файл с байта, где остановились
      outFile = req.resumePath;
      try {
        startBytes = fs.statSync(outFile).size;
      } catch {
        startBytes = 0; // файл увели — качаем заново
      }
    } else {
      const outDir = resolveOutDir(req.outDir);
      outFile = uniquePath(outDir, req.filename);
    }
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  // Отдельную дорожку или отрезок из файла умеет вырезать только ffmpeg
  // (без перекодирования; отрезок читается прямо по http range)
  const streams = req.streams ?? 'both';
  if (streams !== 'both' || req.cut) {
    startFfmpegCopy(req, outFile, streams);
    return;
  }

  const ac = new AbortController();
  const job: RunningJob = { canceled: false, paused: false, kill: () => ac.abort() };
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });
  log('direct start', req.jobId, req.url, '->', outFile);

  const headers: Record<string, string> = {};
  if (req.headers?.referer) headers.Referer = req.headers.referer;
  if (req.headers?.userAgent) headers['User-Agent'] = req.headers.userAgent;
  if (startBytes > 0) headers.Range = `bytes=${startBytes}-`;

  let out: fs.WriteStream | null = null;
  let bytes = startBytes;
  try {
    const resp = await fetch(req.url, { headers, signal: ac.signal, redirect: 'follow' });
    if (resp.status === 416 && startBytes > 0) {
      // Диапазон за концом файла — всё уже скачано до паузы
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'done', progress: 1, bytes: startBytes, outFile });
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error('пустой ответ сервера');
    const appending = startBytes > 0 && resp.status === 206;
    if (startBytes > 0 && !appending) {
      // Сервер не умеет Range — честно начинаем сначала
      startBytes = 0;
      bytes = 0;
    }
    let totalBytes: number | undefined;
    if (appending) {
      const m = resp.headers.get('content-range')?.match(/\/(\d+)\s*$/);
      totalBytes = m ? Number(m[1]) : startBytes + (Number(resp.headers.get('content-length')) || 0) || undefined;
    } else {
      totalBytes = Number(resp.headers.get('content-length')) || undefined;
    }
    out = fs.createWriteStream(outFile, { flags: appending ? 'a' : 'w' });
    let lastSent = 0;
    for await (const chunk of resp.body) {
      const buf = Buffer.from(chunk as Uint8Array);
      bytes += buf.length;
      if (!out.write(buf)) await once(out, 'drain');
      const now = Date.now();
      if (now - lastSent >= 1000) {
        lastSent = now;
        emit({
          type: 'job',
          jobId: req.jobId,
          state: 'running',
          progress: totalBytes ? Math.min(0.999, bytes / totalBytes) : null,
          bytes,
          totalBytes,
        });
      }
    }
    await new Promise<void>((resolve, reject) => out!.end((err?: Error | null) => (err ? reject(err) : resolve())));
    jobs.delete(req.jobId);
    log('direct done', req.jobId, bytes, 'bytes');
    emit({ type: 'job', jobId: req.jobId, state: 'done', progress: 1, bytes, totalBytes, outFile });
  } catch (e) {
    jobs.delete(req.jobId);
    if (out) out.destroy();
    if (job.paused) {
      // Недокачанное оставляем — по нему продолжим через Range
      log('direct paused', req.jobId, bytes, 'bytes');
      emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, bytes, outFile });
      return;
    }
    // недокачанный файл бесполезен — убираем и при отмене, и при ошибке
    fs.rm(outFile, { force: true }, () => {});
    if (job.canceled) {
      log('direct canceled', req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'canceled', progress: null });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log('direct error', req.jobId, msg);
      emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: msg });
    }
  }
}

function startYtdlp(req: YtdlpJobRequest): void {
  const handle = engine.download(
    {
      pageUrl: req.pageUrl,
      outDir: req.outDir?.trim() || defaultOutDir,
      streams: req.streams,
      filenameStem: req.filenameStem,
      maxHeight: req.maxHeight,
      resumePath: req.resumePath,
      cut: req.cut,
    },
    {
      onProgress: ytdlpProgressToEmit(req.jobId),
      onFinish: (r) => {
        jobs.delete(req.jobId);
        if (r.state === 'done') {
          emit({ type: 'job', jobId: req.jobId, state: 'done', progress: 1, outFile: r.outFile });
        } else if (r.state === 'paused') {
          emit({ type: 'job', jobId: req.jobId, state: 'paused', progress: null, outFile: r.outFile });
        } else if (r.state === 'canceled') {
          emit({ type: 'job', jobId: req.jobId, state: 'canceled', progress: null });
        } else {
          emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: r.message });
        }
      },
    },
  );
  const job: RunningJob = {
    canceled: false,
    paused: false,
    kill() {
      if (this.paused) handle.pause();
      else handle.cancel();
    },
  };
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });
}

// ---------- Разведка форматов (yt-dlp -J) ----------

function probe(req: ProbeRequest): void {
  void engine.probe(req.pageUrl).then((r) => {
    sendMessage({ type: 'probe', reqId: req.reqId, ...r });
  });
}

// ---------- Обложка страницы ----------

function startThumbnail(req: ThumbnailJobRequest): void {
  let outFile: string;
  let stemPath: string;
  try {
    const outDir = resolveOutDir(req.outDir);
    outFile = uniquePath(outDir, `${req.filenameStem}.jpg`);
    stemPath = outFile.slice(0, -4); // без .jpg — расширение допишет yt-dlp
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const args = [
    ...YTDLP_COMMON_ARGS, '--no-playlist', '--skip-download',
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '-o', `thumbnail:${stemPath}.%(ext)s`,
  ];
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  args.push(req.pageUrl);

  log('thumbnail start', req.jobId, req.pageUrl, '->', outFile);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let errTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });
  child.on('error', (e) => {
    jobs.delete(req.jobId);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить yt-dlp: ${e.message}` });
  });
  child.on('close', (code) => {
    log('thumbnail exit', req.jobId, code, 'canceled:', job.canceled);
    // Конвертер мог оставить исходник (.webp) рядом — не мусорим
    for (const ext of ['webp', 'png']) {
      fs.rm(`${stemPath}.${ext}`, { force: true }, () => {});
    }
    if (!job.canceled && code === 0 && !fs.existsSync(outFile)) {
      jobs.delete(req.jobId);
      emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: 'У страницы не нашлось обложки' });
      return;
    }
    jobDone(req.jobId, code, { canceled: job.canceled }, outFile, errTail);
  });
}

// ---------- Кадры-превью ----------

// Не даём ffmpeg разгуляться: превью — фон, загрузки важнее
const THUMB_CONCURRENCY = 2;
const THUMB_TIMEOUT_MS = 20_000;
const thumbQueue: ThumbRequest[] = [];
let thumbActive = 0;

function enqueueThumb(req: ThumbRequest): void {
  thumbQueue.push(req);
  pumpThumbs();
}

function pumpThumbs(): void {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const req = thumbQueue.shift()!;
    thumbActive++;
    runThumb(req, () => {
      thumbActive--;
      pumpThumbs();
    });
  }
}

function runThumb(req: ThumbRequest, done: () => void): void {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (req.headers?.userAgent) args.push('-user_agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('-referer', req.headers.referer);
  args.push(
    '-ss', '1',
    '-i', req.url,
    '-frames:v', '1',
    '-vf', 'scale=192:-2',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-q:v', '5',
    'pipe:1',
  );

  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const chunks: Buffer[] = [];
  let finished = false;
  const finish = (dataUrl: string | null): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    sendMessage({ type: 'thumb', reqId: req.reqId, dataUrl });
    done();
  };
  const timer = setTimeout(() => {
    log('thumb timeout', req.url);
    child.kill('SIGKILL');
  }, THUMB_TIMEOUT_MS);

  child.stdout?.on('data', (d: Buffer) => chunks.push(d));
  child.on('error', (e) => {
    log('thumb spawn error', e.message);
    finish(null);
  });
  child.on('close', (code) => {
    const buf = Buffer.concat(chunks);
    finish(code === 0 && buf.length > 0 ? `data:image/jpeg;base64,${buf.toString('base64')}` : null);
  });
}

function pickDir(req: PickDirRequest): void {
  // Диалог выбора папки — через PowerShell (WinForms). Асинхронно, чтобы
  // не блокировать прогресс идущих загрузок, пока диалог открыт.
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = 'Папка загрузок YaDaun'",
    '$f.ShowNewFolderButton = $true',
    'if ($env:DOWNY_CURRENT_DIR -and (Test-Path -LiteralPath $env:DOWNY_CURRENT_DIR)) { $f.SelectedPath = $env:DOWNY_CURRENT_DIR }',
    // TopMost-владелец, иначе диалог откроется позади браузера
    '$w = New-Object System.Windows.Forms.Form',
    '$w.TopMost = $true',
    "if ($f.ShowDialog($w) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }",
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, DOWNY_CURRENT_DIR: req.current ?? '' },
  });
  // Пока диалог открыт, шлём heartbeat — иначе Chrome усыпит service worker
  const heartbeat = setInterval(() => sendMessage({ type: 'heartbeat' }), 10_000);
  let out = '';
  let finished = false;
  const finish = (dir: string | null): void => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    log('pick_dir result', dir ?? '(отмена)');
    sendMessage({ type: 'pick_dir', reqId: req.reqId, dir });
  };
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.on('error', (e) => {
    log('pick_dir spawn error', e.message);
    finish(null);
  });
  child.on('close', () => {
    finish(out.trim() || null);
  });
}

function showInFolder(target: string): void {
  log('show_in_folder', target);
  // Файл могли переместить/удалить — тогда открываем хотя бы папку.
  // Кавычки ставим сами: авто-квотирование Node оборачивает «/select,путь»
  // целиком, explorer такое не понимает и молча открывает «Документы».
  const arg = fs.existsSync(target) ? `/select,"${target}"` : `"${path.dirname(target)}"`;
  spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

// ---------- Самообновление ----------

const REPO = 'dimalebedeff/downy';
// Корень установки (папка с package.json и build.mjs)
const installRoot = path.join(coappRoot, '..');
// Список файлов, приехавших из релиза при прошлом обновлении, — чтобы при
// следующем удалить те, которых в новом релизе больше нет (cpSync сам не удаляет)
const updateFilesManifest = path.join(installRoot, '.update-files.json');

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

/** Удаляет файлы прошлого релиза, исчезнувшие в новом. Никогда не трогает
 *  сгенерированное (node_modules, dist, bin, логи) — их в списках релизов нет. */
function pruneRemovedFiles(newFiles: string[]): void {
  let prev: string[];
  try {
    prev = JSON.parse(fs.readFileSync(updateFilesManifest, 'utf8')) as string[];
  } catch {
    prev = []; // первого списка ещё нет — удалять нечего
  }
  const fresh = new Set(newFiles);
  for (const rel of prev) {
    if (fresh.has(rel)) continue;
    const target = path.resolve(installRoot, rel);
    // Страховка от выхода за пределы установки (кривой список и т.п.)
    if (!target.startsWith(installRoot + path.sep)) continue;
    try {
      fs.rmSync(target, { force: true });
      log('update: pruned', rel);
    } catch {
      // занятый файл удалим при следующем обновлении
    }
  }
  fs.writeFileSync(updateFilesManifest, JSON.stringify(newFiles));
}

function runStep(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let errTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-1000);
    });
    child.on('error', (e) => resolve(`не удалось запустить ${cmd}: ${e.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : errTail || `${cmd}: exit code ${code}`));
  });
}

async function runUpdate(req: UpdateRequest): Promise<void> {
  const emitUpdate = (state: 'downloading' | 'installing' | 'done' | 'error', message?: string): void => {
    sendMessage({ type: 'update', reqId: req.reqId, state, message });
  };
  if (jobs.size > 0) {
    emitUpdate('error', 'Дождись окончания загрузок');
    return;
  }
  // npm install может идти минуту — не даём Chrome усыпить service worker
  const heartbeat = setInterval(() => sendMessage({ type: 'heartbeat' }), 10_000);
  const tmpDir = path.join(os.tmpdir(), `downy-update-${Date.now()}`);
  try {
    // Тег приходит из GitHub API, но в URL он попадает только валидным
    if (!/^v?[\w.-]+$/.test(req.tag)) throw new Error(`подозрительный тег: ${req.tag}`);
    log('update start', req.tag);
    emitUpdate('downloading');
    const zipPath = path.join(tmpDir, 'downy.zip');
    fs.mkdirSync(tmpDir, { recursive: true });
    const resp = await fetch(`https://codeload.github.com/${REPO}/zip/refs/tags/${req.tag}`, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`GitHub ответил HTTP ${resp.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await resp.arrayBuffer()));

    const extractDir = path.join(tmpDir, 'src');
    const unzipErr = await runStep('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], tmpDir);
    if (unzipErr) throw new Error(`распаковка: ${unzipErr}`);
    // Внутри zipball один корневой каталог вида downy-0.4
    const [srcRoot] = fs.readdirSync(extractDir).map((n) => path.join(extractDir, n));
    if (!srcRoot || !fs.existsSync(path.join(srcRoot, 'package.json'))) {
      throw new Error('в архиве нет package.json — неожиданная структура');
    }

    emitUpdate('installing');
    // Копируем исходники поверх установки; dist и bin архив не содержит,
    // поэтому работающая версия остаётся целой до успешной сборки ниже
    fs.cpSync(srcRoot, installRoot, { recursive: true, force: true });
    const npmErr = await runStep('cmd.exe', ['/c', 'npm', 'install', '--no-audit', '--no-fund'], installRoot);
    if (npmErr) throw new Error(`npm install: ${npmErr}`);
    const buildErr = await runStep(process.execPath, ['build.mjs'], installRoot);
    if (buildErr) throw new Error(`сборка: ${buildErr}`);

    // Только после успешной сборки: при провале старые файлы не трогаем
    pruneRemovedFiles(listFilesRecursive(srcRoot));

    // Свежий yt-dlp важен (сайты ломают экстракторы), но его сбой не фатален
    const ytdlpErr = await runStep(ytdlpPath, ['-U'], installRoot);
    if (ytdlpErr) log('update: yt-dlp -U failed (non-fatal):', ytdlpErr.slice(-300));

    log('update done', req.tag);
    emitUpdate('done');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('update error', msg);
    emitUpdate('error', msg);
  } finally {
    clearInterval(heartbeat);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

function cancel(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.canceled = true;
  log('cancel', jobId);
  job.kill();
}

function pause(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.paused = true;
  log('pause', jobId);
  job.kill();
}

process.on('uncaughtException', (e) => log('uncaught', e.stack ?? e.message));

readMessages((raw) => {
  const msg = raw as CoAppRequest;
  log('recv', JSON.stringify(msg).slice(0, 300));
  switch (msg.type) {
    case 'ping':
      sendMessage({
        type: 'pong',
        version: VERSION,
        ffmpeg: binWorks(ffmpegPath, '-version'),
        ytdlp: binWorks(ytdlpPath, '--version'),
        defaultOutDir,
      });
      break;
    case 'pick_dir':
      pickDir(msg);
      break;
    case 'thumb':
      enqueueThumb(msg);
      break;
    case 'show_in_folder':
      showInFolder(msg.path);
      break;
    case 'download_hls':
      startHls(msg);
      break;
    case 'download_direct':
      void startDirect(msg);
      break;
    case 'download_ytdlp':
      startYtdlp(msg);
      break;
    case 'download_thumbnail':
      startThumbnail(msg);
      break;
    case 'probe':
      probe(msg);
      break;
    case 'cancel':
      cancel(msg.jobId);
      break;
    case 'pause':
      pause(msg.jobId);
      break;
    case 'cleanup_partials':
      // Отмена паузы: убрать недокачанный файл и хвосты yt-dlp
      cleanupPartials(msg.path);
      break;
    case 'update':
      void runUpdate(msg);
      break;
  }
});

log('coapp started, ffmpeg:', ffmpegPath, 'yt-dlp:', ytdlpPath);
