import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMessages, sendMessage } from './nm';
import type { CoAppRequest, DirectJobRequest, HlsJobRequest, JobEvent, PickDirRequest, YtdlpJobRequest } from '../../shared/protocol';

const VERSION = '0.2.0';

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

function findBin(name: string): string {
  const local = path.join(binDir, `${name}.exe`);
  return fs.existsSync(local) ? local : name; // иначе надеемся на PATH
}

const ffmpegPath = findBin('ffmpeg');
const ytdlpPath = findBin('yt-dlp');

function binWorks(bin: string, versionArg: string): boolean {
  try {
    return spawnSync(bin, [versionArg], { windowsHide: true, timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

const defaultOutDir = path.join(os.homedir(), 'Downloads', 'downy');

function resolveOutDir(requested?: string): string {
  const dir = requested?.trim() || defaultOutDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

interface RunningJob {
  canceled: boolean;
  kill(): void;
}

const jobs = new Map<string, RunningJob>();

function processJob(child: ChildProcess): RunningJob {
  return {
    canceled: false,
    kill() {
      const pid = child.pid;
      if (pid) {
        // yt-dlp порождает ffmpeg — убиваем всё дерево процессов
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          return;
        } catch {
          // ниже — фолбэк
        }
      }
      child.kill();
    },
  };
}

function emit(event: JobEvent): void {
  sendMessage(event);
}

function jobDone(jobId: string, code: number | null, canceled: boolean, outFile: string, errTail: string): void {
  jobs.delete(jobId);
  if (canceled) {
    fs.rm(outFile, { force: true }, () => {});
    emit({ type: 'job', jobId, state: 'canceled', progress: null });
  } else if (code === 0) {
    emit({ type: 'job', jobId, state: 'done', progress: 1, outFile });
  } else {
    emit({ type: 'job', jobId, state: 'error', progress: null, message: errTail.slice(-500) || `exit code ${code}` });
  }
}

function startHls(req: HlsJobRequest): void {
  let outFile: string;
  try {
    const outDir = resolveOutDir(req.outDir);
    const filename = req.filename.toLowerCase().endsWith('.mp4') ? req.filename : `${req.filename}.mp4`;
    outFile = uniquePath(outDir, filename);
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const args = ['-y', '-nostdin', '-hide_banner'];
  if (req.headers?.userAgent) args.push('-user_agent', req.headers.userAgent);
  if (req.headers?.referer) args.push('-referer', req.headers.referer);
  args.push('-i', req.url, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', outFile);

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
      progress = Math.min(0.999, done / durationSec);
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
    log('ffmpeg exit', req.jobId, code, 'canceled:', job.canceled);
    jobDone(req.jobId, code, job.canceled, outFile, errTail);
  });
}

async function startDirect(req: DirectJobRequest): Promise<void> {
  let outFile: string;
  try {
    const outDir = resolveOutDir(req.outDir);
    outFile = uniquePath(outDir, req.filename);
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const ac = new AbortController();
  const job: RunningJob = { canceled: false, kill: () => ac.abort() };
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });
  log('direct start', req.jobId, req.url, '->', outFile);

  const headers: Record<string, string> = {};
  if (req.headers?.referer) headers.Referer = req.headers.referer;
  if (req.headers?.userAgent) headers['User-Agent'] = req.headers.userAgent;

  let out: fs.WriteStream | null = null;
  try {
    const resp = await fetch(req.url, { headers, signal: ac.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error('пустой ответ сервера');
    const totalBytes = Number(resp.headers.get('content-length')) || undefined;
    out = fs.createWriteStream(outFile);
    let bytes = 0;
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
  let outDir: string;
  try {
    outDir = resolveOutDir(req.outDir);
  } catch (e) {
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: String(e) });
    return;
  }

  const args = ['--newline', '--no-playlist', '-P', outDir, '-o', '%(title).120s [%(id)s].%(ext)s'];
  if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
  args.push(req.pageUrl);

  log('yt-dlp start', req.jobId, req.pageUrl);
  const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const job = processJob(child);
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let outFile = '';
  let errTail = '';
  let lastSent = 0;

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    const dest = s.match(/\[download\] Destination: (.+)/) ?? s.match(/\[Merger\] Merging formats into "(.+)"/);
    if (dest) outFile = dest[1].trim();
    // Пример строки: "[download]  42.5% of   12.34MiB at  1.23MiB/s ETA 00:05"
    const pct = s.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)(B|KiB|MiB|GiB|TiB))?/);
    if (pct) {
      const now = Date.now();
      if (now - lastSent >= 1000) {
        lastSent = now;
        const progress = Math.min(0.999, parseFloat(pct[1]) / 100);
        let totalBytes: number | undefined;
        if (pct[2]) {
          const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[pct[3] as 'B' | 'KiB' | 'MiB' | 'GiB' | 'TiB'];
          totalBytes = Math.round(parseFloat(pct[2]) * mult);
        }
        emit({
          type: 'job',
          jobId: req.jobId,
          state: 'running',
          progress,
          totalBytes,
          bytes: totalBytes ? Math.round(totalBytes * progress) : undefined,
        });
      }
    }
  });

  child.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  child.on('error', (e) => {
    jobs.delete(req.jobId);
    log('yt-dlp spawn error', e.message);
    emit({ type: 'job', jobId: req.jobId, state: 'error', progress: null, message: `Не удалось запустить yt-dlp: ${e.message}` });
  });

  child.on('close', (code) => {
    log('yt-dlp exit', req.jobId, code, 'canceled:', job.canceled);
    jobDone(req.jobId, code, job.canceled, outFile, errTail);
  });
}

function pickDir(req: PickDirRequest): void {
  // Диалог выбора папки — через PowerShell (WinForms). Асинхронно, чтобы
  // не блокировать прогресс идущих загрузок, пока диалог открыт.
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = 'Папка загрузок Downy'",
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
  let out = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.on('error', (e) => {
    log('pick_dir spawn error', e.message);
    sendMessage({ type: 'pick_dir', reqId: req.reqId, dir: null });
  });
  child.on('close', () => {
    const dir = out.trim() || null;
    log('pick_dir result', dir ?? '(отмена)');
    sendMessage({ type: 'pick_dir', reqId: req.reqId, dir });
  });
}

function cancel(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.canceled = true;
  log('cancel', jobId);
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
    case 'download_hls':
      startHls(msg);
      break;
    case 'download_direct':
      void startDirect(msg);
      break;
    case 'download_ytdlp':
      startYtdlp(msg);
      break;
    case 'cancel':
      cancel(msg.jobId);
      break;
  }
});

log('coapp started, ffmpeg:', ffmpegPath, 'yt-dlp:', ytdlpPath);
