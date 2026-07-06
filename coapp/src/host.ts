import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMessages, sendMessage } from './nm';
import type { CoAppRequest, HlsJobRequest, JobEvent, YtdlpJobRequest } from '../../shared/protocol';

const VERSION = '0.1.0';

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
  child: ChildProcess;
  canceled: boolean;
}

const jobs = new Map<string, RunningJob>();

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
  const job: RunningJob = { child, canceled: false };
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

  child.stdout?.on('data', (d: Buffer) => {
    const m = d.toString().match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m || !durationSec) return;
    const done = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    emit({
      type: 'job',
      jobId: req.jobId,
      state: 'running',
      progress: Math.min(0.999, done / durationSec),
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
  const job: RunningJob = { child, canceled: false };
  jobs.set(req.jobId, job);
  emit({ type: 'job', jobId: req.jobId, state: 'running', progress: null });

  let outFile = '';
  let errTail = '';
  let lastSent = 0;

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString();
    const dest = s.match(/\[download\] Destination: (.+)/) ?? s.match(/\[Merger\] Merging formats into "(.+)"/);
    if (dest) outFile = dest[1].trim();
    const pct = s.match(/\[download\]\s+([\d.]+)%/);
    if (pct) {
      const now = Date.now();
      if (now - lastSent >= 1000) {
        lastSent = now;
        emit({ type: 'job', jobId: req.jobId, state: 'running', progress: Math.min(0.999, parseFloat(pct[1]) / 100) });
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

function cancel(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.canceled = true;
  const pid = job.child.pid;
  log('cancel', jobId, 'pid', pid);
  if (pid) {
    // yt-dlp порождает ffmpeg — убиваем всё дерево процессов
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      // ниже — фолбэк
    }
  }
  job.child.kill();
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
      });
      break;
    case 'download_hls':
      startHls(msg);
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
