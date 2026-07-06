// Регистрирует CoApp как Native Messaging host для Chrome и Edge (текущий пользователь).
// Запуск: npm run coapp:install

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.downy.coapp';

const coappDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(coappDir, '..', 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.key) {
  console.error('В extension/manifest.json нет поля key — не могу вычислить extension ID');
  process.exit(1);
}

// Extension ID = первые 16 байт SHA-256 от DER публичного ключа, hex → буквы a-p
const der = Buffer.from(manifest.key, 'base64');
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const extId = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const hostCjs = path.join(coappDir, 'dist', 'host.cjs');
if (!fs.existsSync(hostCjs)) {
  console.error('coapp/dist/host.cjs не найден — сначала запусти npm run build');
  process.exit(1);
}

const batPath = path.join(coappDir, 'run-host.bat');
fs.writeFileSync(batPath, `@echo off\r\n"${process.execPath}" "%~dp0dist\\host.cjs"\r\n`);

const hostManifestPath = path.join(coappDir, 'host-manifest.json');
fs.writeFileSync(
  hostManifestPath,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Downy companion app (HLS via ffmpeg, yt-dlp)',
      path: batPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extId}/`],
    },
    null,
    2,
  ),
);

const regKeys = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];
for (const key of regKeys) {
  execSync(`reg add "${key}" /ve /t REG_SZ /d "${hostManifestPath}" /f`, { stdio: 'inherit' });
}

console.log('');
console.log('CoApp зарегистрирован.');
console.log(`Extension ID: ${extId}`);
console.log(`Host manifest: ${hostManifestPath}`);
console.log('Перезапусти браузер, чтобы он увидел нативный хост.');
