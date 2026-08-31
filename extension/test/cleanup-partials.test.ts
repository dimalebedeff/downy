import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupPartials } from '../../shared/ytdlp';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downy-cleanup-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function touch(name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
}

function left(): string[] {
  return fs.readdirSync(dir).sort();
}

describe('cleanupPartials', () => {
  it('убирает сам файл и хвосты yt-dlp', () => {
    touch('Ролик.mp4');
    touch('Ролик.mp4.part');
    touch('Ролик.mp4.part-Frag1.part');
    touch('Ролик.mp4.ytdl');
    cleanupPartials(path.join(dir, 'Ролик.mp4'));
    expect(left()).toEqual([]);
  });

  it('убирает скачанный исходник вырезки дорожки', () => {
    // HLS «только звук» качается в <имя>.dl.mp4, а вырезка кладёт рядом
    // финальный файл. Отменили на паузе — исходник тоже мусор
    touch('Ролик.m4a');
    touch('Ролик.m4a.dl.mp4');
    cleanupPartials(path.join(dir, 'Ролик.m4a'));
    expect(left()).toEqual([]);
  });

  it('чужие файлы с похожим именем не трогает', () => {
    touch('Ролик.mp4.bak');
    touch('Ролик.mp4.txt');
    touch('Ролик другой.mp4');
    cleanupPartials(path.join(dir, 'Ролик.mp4'));
    expect(left()).toEqual(['Ролик другой.mp4', 'Ролик.mp4.bak', 'Ролик.mp4.txt'].sort());
  });

  it('пропавшая папка не роняет чистку', () => {
    expect(() => cleanupPartials(path.join(dir, 'нет', 'Ролик.mp4'))).not.toThrow();
  });
});
