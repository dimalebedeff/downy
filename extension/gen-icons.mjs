// Генератор иконок расширения: жёлтая стрелка загрузки на тёмном фоне.
// Без зависимостей — PNG кодируется вручную. Запуск: node extension/gen-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x1d, 0x1f, 0x25]; // тёмный фон, в тон карточкам попапа (--card тёмной темы)
const FG = [0xf5, 0xc5, 0x18]; // фирменный жёлтый (--accent попапа)

// --- Фигуры в нормализованных координатах [0..1] ---

const CORNER_R = 0.2;

function insideRoundedSquare(x, y) {
  const r = CORNER_R;
  const cx = Math.max(r - x, x - (1 - r), 0);
  const cy = Math.max(r - y, y - (1 - r), 0);
  return cx * cx + cy * cy <= r * r;
}

function insideArrow(x, y) {
  // Стержень стрелки
  if (Math.abs(x - 0.5) <= 0.085 && y >= 0.17 && y <= 0.5) return true;
  // Наконечник: треугольник основанием вверх, остриём вниз
  if (y >= 0.5 && y <= 0.73) {
    const halfWidth = 0.25 * (1 - (y - 0.5) / 0.23);
    if (Math.abs(x - 0.5) <= halfWidth) return true;
  }
  // Полка-лоток снизу
  if (x >= 0.2 && x <= 0.8 && y >= 0.8 && y <= 0.885) return true;
  return false;
}

// --- Растеризация с суперсэмплингом 4x4 ---

function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!insideRoundedSquare(x, y)) continue;
          bgHits++;
          if (insideArrow(x, y)) fgHits++;
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const fgFrac = bgHits ? fgHits / bgHits : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * fgFrac);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// --- Минимальный PNG-энкодер (RGBA8, без interlace) ---

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // цветовой тип RGBA
  // Скан-строки с фильтром 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log('written', file);
}
