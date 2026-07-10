// Движок yt-dlp: разведка форматов и скачивание по URL страницы.
// Общий для coapp (native messaging) и телеграм-бота: о транспорте ничего
// не знает, события отдаёт колбэками.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localDateStamp } from './filename';
import type { CutRange, ProbeFormat, StreamSelection } from './protocol';

type Log = (...args: unknown[]) => void;

// Сегменты качаем параллельно: последовательная загрузка упирается в
// задержку сети и per-connection-троттлинг CDN (ВК и т.п.)
export const HLS_CONCURRENCY = '8';

// Без --encoding yt-dlp пишет в stdout в кодировке консоли (cp1251) — кириллица
// в путях превращается в кракозябры, и «показать в папке» не находит файл
export const YTDLP_COMMON_ARGS = ['--newline', '--encoding', 'utf-8'];

export function findBin(binDir: string, name: string): string {
  const local = path.join(binDir, `${name}.exe`);
  return fs.existsSync(local) ? local : name; // иначе надеемся на PATH
}

export function binWorks(bin: string, versionArg: string): boolean {
  try {
    return spawnSync(bin, [versionArg], { windowsHide: true, timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

export function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/** Убирает сам файл и хвосты yt-dlp (.part, .part-FragN, .ytdl) */
export function cleanupPartials(outFile: string): void {
  const dir = path.dirname(outFile);
  const base = path.basename(outFile);
  try {
    for (const f of fs.readdirSync(dir)) {
      // Только известные суффиксы yt-dlp: по голому префиксу можно зацепить
      // чужой файл вида «имя.mp4.bak»
      if (f === base || f.startsWith(`${base}.part`) || f === `${base}.ytdl`) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch {
    // папку могли удалить — не мешаем завершению джоба
  }
}

/** yt-dlp порождает ffmpeg — убиваем всё дерево процессов */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      // ниже — фолбэк
    }
  }
  child.kill();
}

/** Формат-строка yt-dlp: предпочитаем mp4/m4a, качество не выше maxHeight */
export function ytdlpFormatArgs(streams: StreamSelection, maxHeight?: number): string[] {
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  if (streams === 'video') return ['-f', `bestvideo${h}[ext=mp4]/bestvideo${h}/best${h}`];
  if (streams === 'audio') return ['-f', 'bestaudio[ext=m4a]/bestaudio/best'];
  return ['-f', `bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${h}+bestaudio/best${h}`];
}

export interface YtdlpProgress {
  /** 0..0.999 */
  progress: number;
  bytes?: number;
  totalBytes?: number;
}

/**
 * Строка прогресса yt-dlp:
 * "[download]  42.5% of   12.34MiB at  1.23MiB/s ETA 00:05"
 */
export function parseYtdlpProgressLine(s: string): YtdlpProgress | null {
  const pct = s.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)(B|KiB|MiB|GiB|TiB))?/);
  if (!pct) return null;
  const progress = Math.min(0.999, parseFloat(pct[1]) / 100);
  let totalBytes: number | undefined;
  if (pct[2]) {
    const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[pct[3] as 'B' | 'KiB' | 'MiB' | 'GiB' | 'TiB'];
    totalBytes = Math.round(parseFloat(pct[2]) * mult);
  }
  return {
    progress,
    totalBytes,
    bytes: totalBytes ? Math.round(totalBytes * progress) : undefined,
  };
}

/** Путь итогового файла из stdout yt-dlp */
export function parseYtdlpDestination(s: string): string | null {
  const dest = s.match(/\[download\] Destination: (.+)/) ?? s.match(/\[Merger\] Merging formats into "(.+)"/);
  return dest ? dest[1].trim() : null;
}

/** Обработчик stdout yt-dlp: прогресс не чаще раза в секунду + путь файла */
export function makeYtdlpStdoutHandler(
  onProgress: (p: YtdlpProgress) => void,
  onOutFile?: (file: string) => void,
): (d: Buffer) => void {
  let lastSent = 0;
  return (d: Buffer) => {
    const s = d.toString();
    if (onOutFile) {
      const dest = parseYtdlpDestination(s);
      if (dest) onOutFile(dest);
    }
    const p = parseYtdlpProgressLine(s);
    if (!p) return;
    const now = Date.now();
    if (now - lastSent < 1000) return;
    lastSent = now;
    onProgress(p);
  };
}

// ---------- Разведка форматов (yt-dlp -J) ----------

const PROBE_TIMEOUT_MS = 30_000;

interface YtdlpJsonFormat {
  height?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  /** Суммарный битрейт, КБит/с — у HLS (X и ко) размера нет, оцениваем по нему */
  tbr?: number | null;
}

/** Вес формата: точный, приблизительный или оценка битрейт × длительность */
function formatSize(f: YtdlpJsonFormat, durationSec?: number | null): number | undefined {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  // tbr в КБит/с: × 1000 / 8 = × 125 байт в секунду
  if (f.tbr && durationSec) return Math.round(f.tbr * 125 * durationSec);
  return undefined;
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  title?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  formats?: ProbeFormat[];
}

export interface YtdlpDownloadOptions {
  pageUrl: string;
  /** Папка сохранения (создаётся при необходимости) */
  outDir: string;
  /** По умолчанию 'both' */
  streams?: StreamSelection;
  /**
   * Имя файла без расширения (уже безопасное). Задано — контейнер (.mp4/.m4a)
   * подберётся сам, имя защищено от перезаписи; нет — yt-dlp именует по шаблону.
   */
  filenameStem?: string;
  /** Планка качества: не выше этой высоты (720, 1080, …). Нет — лучшее. */
  maxHeight?: number;
  /** Резюм после паузы: точный путь недокачанного файла (без uniquePath) */
  resumePath?: string;
  /** Скачать только отрезок: yt-dlp --download-sections */
  cut?: CutRange;
}

export interface YtdlpDownloadEvents {
  onProgress?: (p: YtdlpProgress) => void;
  onFinish: (r: { state: 'done' | 'error' | 'canceled' | 'paused'; outFile?: string; message?: string }) => void;
}

export interface YtdlpDownloadHandle {
  cancel(): void;
  /** Убить процесс, но оставить недокачанное на диске для резюма */
  pause(): void;
}

export interface YtdlpEngine {
  ffmpegPath: string;
  ytdlpPath: string;
  ytdlpWorks(): boolean;
  probe(pageUrl: string, timeoutMs?: number): Promise<ProbeResult>;
  download(opts: YtdlpDownloadOptions, events: YtdlpDownloadEvents): YtdlpDownloadHandle;
}

export function createYtdlpEngine(o: { binDir: string; log?: Log }): YtdlpEngine {
  const log: Log = o.log ?? (() => {});
  const binDir = o.binDir;
  const ffmpegPath = findBin(binDir, 'ffmpeg');
  const ytdlpPath = findBin(binDir, 'yt-dlp');

  let ytdlpOkCache: boolean | null = null;

  function probe(pageUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const args = [...YTDLP_COMMON_ARGS, '--no-playlist', '-J', pageUrl];
      log('probe start', pageUrl);
      const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      const chunks: Buffer[] = [];
      let errTail = '';
      let finished = false;
      const finish = (r: ProbeResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        log('probe timeout', pageUrl);
        child.kill('SIGKILL');
        finish({ ok: false, error: `Разведка форматов не уложилась в ${Math.round(timeoutMs / 1000)} секунд` });
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
      child.stderr?.on('data', (d: Buffer) => {
        errTail = (errTail + d.toString()).slice(-1000);
      });
      child.on('error', (e) => finish({ ok: false, error: `Не удалось запустить yt-dlp: ${e.message}` }));
      child.on('close', (code) => {
        if (code !== 0) {
          log('probe failed', code, errTail.slice(-300));
          finish({ ok: false, error: errTail.slice(-500) || `yt-dlp: exit code ${code}` });
          return;
        }
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            title?: string;
            thumbnail?: string;
            duration?: number | null;
            formats?: YtdlpJsonFormat[];
          };
          const formats: ProbeFormat[] = (info.formats ?? []).map((f) => ({
            height: f.height ?? undefined,
            fps: f.fps ?? undefined,
            hasVideo: !!f.vcodec && f.vcodec !== 'none',
            hasAudio: !!f.acodec && f.acodec !== 'none',
            sizeBytes: formatSize(f, info.duration),
          }));
          log('probe done', formats.length, 'formats');
          finish({ ok: true, title: info.title, thumbnailUrl: info.thumbnail, durationSec: info.duration ?? undefined, formats });
        } catch (e) {
          finish({ ok: false, error: `Разбор ответа yt-dlp: ${e instanceof Error ? e.message : String(e)}` });
        }
      });
    });
  }

  function download(opts: YtdlpDownloadOptions, events: YtdlpDownloadEvents): YtdlpDownloadHandle {
    const noop: YtdlpDownloadHandle = { cancel() {}, pause() {} };
    try {
      fs.mkdirSync(opts.outDir, { recursive: true });
    } catch (e) {
      // Микротаск: подписчик должен успеть получить handle до onFinish
      queueMicrotask(() => events.onFinish({ state: 'error', message: String(e) }));
      return noop;
    }

    const streams = opts.streams ?? 'both';
    const args = [...YTDLP_COMMON_ARGS, '--no-playlist', '--concurrent-fragments', HLS_CONCURRENCY];
    let presetOutFile = '';
    if (opts.resumePath || opts.filenameStem) {
      // Резюм продолжает тот же файл; новое имя защищаем от перезаписи
      presetOutFile = opts.resumePath ?? uniquePath(opts.outDir, opts.filenameStem + (streams === 'audio' ? '.m4a' : '.mp4'));
      args.push('-o', presetOutFile);
      // Контейнер в имени обещан — держим слово, даже если лучший кодек в webm
      if (streams === 'both') args.push('--merge-output-format', 'mp4');
      else if (streams === 'video') args.push('--remux-video', 'mp4');
      else args.push('--remux-video', 'm4a');
    } else {
      // Имени нет — yt-dlp именует сам; дата вместо мусорного айдишника,
      // force-overwrites — иначе повторная закачка молча скипнется
      const nameSuffix = { both: '', video: ' [видео]', audio: ' [аудио]' }[streams];
      args.push('--force-overwrites', '-P', opts.outDir, '-o', `%(title).120s${nameSuffix} [${localDateStamp()}].%(ext)s`);
    }
    if (fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) args.push('--ffmpeg-location', binDir);
    args.push(...ytdlpFormatArgs(streams, opts.maxHeight));
    // Отрезок: yt-dlp качает только нужную секцию (режет ffmpeg по ключевым
    // кадрам). Ютубу не предлагаем — его SABR-потоки ffmpeg не читает
    if (opts.cut) args.push('--download-sections', `*${opts.cut.fromSec ?? 0}-${opts.cut.toSec ?? 'inf'}`);
    args.push(opts.pageUrl);

    log('yt-dlp start', opts.pageUrl, 'streams:', streams, 'maxHeight:', opts.maxHeight ?? 'best');
    const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let canceled = false;
    let paused = false;
    let outFile = presetOutFile;
    let errTail = '';
    let settled = false;

    child.stdout?.on('data', makeYtdlpStdoutHandler(
      (p) => events.onProgress?.(p),
      (f) => {
        if (!presetOutFile) outFile = f;
      },
    ));
    child.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });

    // При ошибке спавна срабатывают и 'error', и 'close' — финиш должен быть один
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      log('yt-dlp spawn error', e.message);
      events.onFinish({ state: 'error', message: `Не удалось запустить yt-dlp: ${e.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      log('yt-dlp exit', code, 'canceled:', canceled, 'paused:', paused);
      if (paused) {
        // Хвосты .part остаются на диске — по ним yt-dlp продолжит.
        // Без preset-имени резюм перезапустит yt-dlp — тот сам подхватит свои .part
        events.onFinish({ state: 'paused', outFile: presetOutFile || undefined });
      } else if (canceled) {
        if (outFile) cleanupPartials(outFile);
        events.onFinish({ state: 'canceled' });
      } else if (code === 0) {
        events.onFinish({ state: 'done', outFile });
      } else {
        events.onFinish({ state: 'error', message: errTail.slice(-500) || `exit code ${code}` });
      }
    });

    return {
      cancel() {
        canceled = true;
        killProcessTree(child);
      },
      pause() {
        paused = true;
        killProcessTree(child);
      },
    };
  }

  return {
    ffmpegPath,
    ytdlpPath,
    ytdlpWorks() {
      if (ytdlpOkCache == null) ytdlpOkCache = binWorks(ytdlpPath, '--version');
      return ytdlpOkCache;
    },
    probe,
    download,
  };
}
