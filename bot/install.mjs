// Регистрирует бота в Планировщике задач Windows: запуск при входе в систему,
// перезапуск при падении, без окна консоли. Запуск: npm run bot:install

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_NAME = 'DownyBot';

const botDir = path.dirname(fileURLToPath(import.meta.url));
const botCjs = path.join(botDir, 'dist', 'bot.cjs');
const configPath = path.join(botDir, 'config.json');
const examplePath = path.join(botDir, 'config.example.json');

if (!fs.existsSync(botCjs)) {
  console.error('bot/dist/bot.cjs не найден — сначала запусти npm run build');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  fs.copyFileSync(examplePath, configPath);
  console.error(`Создал ${configPath} по образцу.`);
  console.error('Заполни apiId, apiHash (my.telegram.org), botToken (@BotFather) и запусти установку снова.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!cfg.apiId || !cfg.botToken || /взять/.test(cfg.apiHash ?? '') || /взять/.test(cfg.botToken ?? '')) {
  console.error(`В ${configPath} не заполнены apiId / apiHash / botToken.`);
  process.exit(1);
}

// bat — для ручного запуска с консолью (отладка), vbs — скрытый запуск задачей
const batPath = path.join(botDir, 'run-bot.bat');
fs.writeFileSync(batPath, `@echo off\r\ncd /d "%~dp0"\r\n"${process.execPath}" "%~dp0dist\\bot.cjs"\r\npause\r\n`);

const vbsPath = path.join(botDir, 'run-bot-hidden.vbs');
fs.writeFileSync(
  vbsPath,
  `CreateObject("Wscript.Shell").Run """${process.execPath}"" ""${botCjs}""", 0, False\r\n`,
);

// schtasks из командной строки не умеет настроить перезапуск при сбое — только XML
const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Downy Telegram bot: ссылка в чат — видео в ответ</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>99</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${vbsPath}"</Arguments>
      <WorkingDirectory>${botDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

const xmlPath = path.join(botDir, 'task.xml');
fs.writeFileSync(xmlPath, taskXml, 'utf16le');

execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${xmlPath}" /F`, { stdio: 'inherit' });
execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'inherit' });

console.log('');
console.log(`Задача «${TASK_NAME}» создана: старт при входе в систему, перезапуск при падении.`);
console.log(`Лог: ${path.join(botDir, 'bot.log')}`);
console.log(`Ручной запуск с консолью: ${batPath}`);
console.log(`Остановить: schtasks /End /TN ${TASK_NAME}; убрать: schtasks /Delete /TN ${TASK_NAME} /F`);
