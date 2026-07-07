# Downy

Аналог [Video DownloadHelper](https://v10.downloadhelper.net/): расширение Chrome находит видео и аудио на страницах, нативное companion-приложение (CoApp) скачивает и склеивает стримы через ffmpeg, а для сложных сайтов использует yt-dlp.

## Что умеет

- Детект медиа на вкладке: прямые файлы (mp4, webm, mp3 и др.) и HLS-стримы (m3u8) — по сетевым запросам и по DOM.
- Бейдж-счётчик на иконке, попап со списком: превью-кадр, название, качество (варианты из мастер-плейлиста), размер/длительность. Если превью нет на странице, CoApp вытаскивает кадр через ffmpeg.
- Все загрузки идут через CoApp: прямые файлы качает сам CoApp, HLS склеивается в mp4 через ffmpeg. Единый список загрузок с шкалой, скачанными МБ/ГБ (для HLS полный размер оценивается) и отменой.
- Кнопка «Скачать страницу через yt-dlp» — запасной экстрактор для сложных сайтов.
- DRM-контент (Netflix и т.п.) не поддерживается принципиально.

## Установка

Нужен Node.js 20+.

```powershell
npm install
npm run build            # собирает extension/dist и coapp/dist
npm run coapp:fetch-bins # скачивает ffmpeg.exe и yt-dlp.exe в coapp/bin
npm run coapp:install    # регистрирует CoApp в реестре (Chrome + Edge)
```

Затем в Chrome: `chrome://extensions` → включить «Режим разработчика» → «Загрузить распакованное расширение» → выбрать папку `extension/dist`. ID расширения фиксированный (`abiepbdpjjbicngclmfgmcpoeopfkedm`) благодаря полю `key` в манифесте, поэтому регистрация CoApp его уже знает. После установки CoApp перезапусти браузер.

В попапе статус «CoApp» должен быть зелёным. Файлы сохраняются в `Downloads\downy`; папка меняется в настройках попапа — руками или через «Обзор…» (нативный диалог выбора папки).

## Установка на другом компьютере

На новой машине (Windows) нужно повторить те же шаги:

1. Установить [Node.js LTS](https://nodejs.org) (или `winget install OpenJS.NodeJS.LTS`).
2. Склонировать репозиторий: `git clone https://github.com/TotallenKrieg/downy.git` — репозиторий приватный, поэтому нужно войти в свой GitHub-аккаунт (проще всего через `winget install GitHub.cli` → `gh auth login` → `gh repo clone TotallenKrieg/downy`).
3. В папке проекта: `npm install && npm run build && npm run coapp:fetch-bins && npm run coapp:install`.
4. Загрузить `extension/dist` как распакованное расширение (см. выше) и перезапустить браузер.

ID расширения одинаковый на всех машинах (задан полем `key` в манифесте), поэтому связка с CoApp работает без донастройки. Бинарники ffmpeg/yt-dlp в git не хранятся — их всегда докачивает `coapp:fetch-bins`.

## Архитектура

```
extension/   MV3-расширение (TypeScript, esbuild)
  src/background.ts   сниффинг webRequest, m3u8-парсинг, связь с CoApp
  src/content.ts      детект <video>/<audio> в DOM
  src/popup/          UI списка и загрузок
coapp/       нативный хост (Node.js, Native Messaging)
  src/host.ts         задания: HLS через ffmpeg, страницы через yt-dlp
  install.mjs         регистрация native messaging host в реестре
  fetch-bins.mjs      загрузка ffmpeg/yt-dlp в coapp/bin
shared/protocol.ts    типы сообщений расширение ↔ CoApp
```

## Разработка

```powershell
npm run build      # сборка
npm test           # unit-тесты (vitest): классификация медиа, m3u8, имена файлов
npm run typecheck  # tsc --noEmit
```

После правок расширения: пересобрать и нажать «Обновить» на карточке расширения в `chrome://extensions`. После правок CoApp достаточно пересобрать (браузер запускает хост заново на каждое соединение).

Лог CoApp: `coapp/coapp.log`.

## Ограничения (пока)

- DASH (mpd) не поддерживается — следующий этап.
- Firefox не поддерживается (код на кросс-браузерном WebExtensions API, портировать несложно).
- Заголовки для ffmpeg передаются только Referer и User-Agent; куки не передаются — редкие сайты с куки-защитой сегментов не скачаются (обычно спасает yt-dlp).
