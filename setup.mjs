// Установка Downy одним запуском: зависимости, сборка, бинарники, регистрация CoApp.
// Запускается из install.bat (или руками: node setup.mjs).

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const steps = [
  ['Установка зависимостей', 'npm install'],
  ['Сборка расширения и CoApp', 'npm run build'],
  ['Загрузка ffmpeg и yt-dlp', 'npm run coapp:fetch-bins'],
  ['Регистрация CoApp в Chrome и Edge', 'npm run coapp:install'],
];

for (const [i, [title, cmd]] of steps.entries()) {
  console.log(`\n[${i + 1}/${steps.length}] ${title}…`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: root, shell: true });
  } catch {
    console.error(`\nШаг «${title}» завершился с ошибкой — посмотри сообщения выше.`);
    process.exit(1);
  }
}

console.log(`
================================================================
Готово! Осталось подключить расширение в браузере:
  1. Открой chrome://extensions и включи «Режим разработчика».
  2. Нажми «Загрузить распакованное расширение» и выбери папку
     ${path.join(root, 'extension', 'dist')}
  3. Перезапусти браузер.
================================================================`);
