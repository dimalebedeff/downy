// Протокол сообщений между расширением и CoApp (Native Messaging).

/** Какие дорожки сохранять: всё, только видео или только аудио */
export type StreamSelection = 'both' | 'video' | 'audio';

/** Скачивание стрима (HLS или DASH) — yt-dlp понимает оба формата */
export interface HlsJobRequest {
  type: 'download_hls';
  jobId: string;
  /** URL m3u8-плейлиста (или варианта из мастера) либо mpd-манифеста */
  url: string;
  /** Имя файла с расширением, уже безопасное для файловой системы */
  filename: string;
  /** Папка сохранения; пусто — Downloads\downy */
  outDir?: string;
  /** По умолчанию 'both' */
  streams?: StreamSelection;
  /** Резюм после паузы: точный путь недокачанного файла (без uniquePath) */
  resumePath?: string;
  headers?: {
    referer?: string;
    userAgent?: string;
  };
}

export interface DirectJobRequest {
  type: 'download_direct';
  jobId: string;
  /** Прямой URL файла (mp4/webm/mp3 и т.п.) */
  url: string;
  /** Имя файла с расширением, уже безопасное для файловой системы */
  filename: string;
  /** Папка сохранения; пусто — Downloads\downy */
  outDir?: string;
  /** По умолчанию 'both' */
  streams?: StreamSelection;
  /** Резюм после паузы: докачиваем этот файл через HTTP Range */
  resumePath?: string;
  headers?: {
    referer?: string;
    userAgent?: string;
  };
}

export interface YtdlpJobRequest {
  type: 'download_ytdlp';
  jobId: string;
  pageUrl: string;
  outDir?: string;
  /** По умолчанию 'both' */
  streams?: StreamSelection;
  /**
   * Имя файла без расширения (уже безопасное). Задано — хост сам подберёт
   * контейнер (.mp4/.m4a) и защитит от перезаписи как uniquePath;
   * не задано — yt-dlp именует по своему шаблону.
   */
  filenameStem?: string;
  /** Планка качества: не выше этой высоты (720, 1080, …). Нет — лучшее. */
  maxHeight?: number;
  /** Резюм после паузы: точный путь недокачанного файла (без uniquePath) */
  resumePath?: string;
}

/** Скачать только обложку страницы (yt-dlp --write-thumbnail, конверт в jpg) */
export interface ThumbnailJobRequest {
  type: 'download_thumbnail';
  jobId: string;
  pageUrl: string;
  /** Имя файла без расширения, уже безопасное */
  filenameStem: string;
  outDir?: string;
}

/** Разведка форматов страницы: yt-dlp -J */
export interface ProbeRequest {
  type: 'probe';
  reqId: string;
  pageUrl: string;
}

/** Один формат из разведки — только то, что нужно для выбора качества */
export interface ProbeFormat {
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Точный или примерный размер в байтах */
  sizeBytes?: number;
}

export interface ProbeEvent {
  type: 'probe';
  reqId: string;
  ok: boolean;
  error?: string;
  title?: string;
  thumbnailUrl?: string;
  formats?: ProbeFormat[];
}

export interface CancelRequest {
  type: 'cancel';
  jobId: string;
}

/** Пауза: убить процесс, но оставить недокачанное на диске для резюма */
export interface PauseRequest {
  type: 'pause';
  jobId: string;
}

/** Прибрать хвосты отменённой паузы (.part, .ytdl и сам файл) */
export interface CleanupPartialsRequest {
  type: 'cleanup_partials';
  path: string;
}

export interface PingRequest {
  type: 'ping';
}

/** Открыть нативный диалог выбора папки */
export interface PickDirRequest {
  type: 'pick_dir';
  reqId: string;
  /** Текущая папка — стартовая точка диалога */
  current?: string;
}

/** Открыть Проводник с выделенным скачанным файлом */
export interface ShowInFolderRequest {
  type: 'show_in_folder';
  path: string;
}

/** Обновить Downy до релиза с GitHub: скачать zipball, пересобрать */
export interface UpdateRequest {
  type: 'update';
  reqId: string;
  /** Тег релиза, например "v0.4" */
  tag: string;
}

/** Вытащить кадр-превью из видео/потока */
export interface ThumbRequest {
  type: 'thumb';
  reqId: string;
  url: string;
  headers?: {
    referer?: string;
    userAgent?: string;
  };
}

export type CoAppRequest =
  | HlsJobRequest
  | DirectJobRequest
  | YtdlpJobRequest
  | ThumbnailJobRequest
  | ProbeRequest
  | CancelRequest
  | PauseRequest
  | CleanupPartialsRequest
  | PingRequest
  | PickDirRequest
  | ThumbRequest
  | ShowInFolderRequest
  | UpdateRequest;

export interface PongEvent {
  type: 'pong';
  version: string;
  ffmpeg: boolean;
  ytdlp: boolean;
  /** Папка сохранения по умолчанию (полный путь) */
  defaultOutDir: string;
}

export interface PickDirEvent {
  type: 'pick_dir';
  reqId: string;
  /** null — пользователь закрыл диалог без выбора */
  dir: string | null;
}

/**
 * Пустое событие «я жив». CoApp шлёт его, пока открыт диалог выбора папки:
 * входящие сообщения сбрасывают таймер простоя MV3 service worker'а,
 * иначе Chrome усыпит его и ответ диалога потеряется.
 */
export interface HeartbeatEvent {
  type: 'heartbeat';
}

export type JobState = 'running' | 'done' | 'error' | 'canceled' | 'paused';

export interface JobEvent {
  type: 'job';
  jobId: string;
  state: JobState;
  /** 0..1 или null, если прогресс неизвестен */
  progress: number | null;
  /** Сколько байт уже скачано/записано */
  bytes?: number;
  /** Полный размер в байтах, если известен */
  totalBytes?: number;
  message?: string;
  outFile?: string;
}

export interface ThumbEvent {
  type: 'thumb';
  reqId: string;
  /** data:image/jpeg;base64,… или null, если кадр вытащить не удалось */
  dataUrl: string | null;
}

/** Прогресс обновления Downy */
export interface UpdateEvent {
  type: 'update';
  reqId: string;
  state: 'downloading' | 'installing' | 'done' | 'error';
  message?: string;
}

export type CoAppEvent = PongEvent | JobEvent | PickDirEvent | ThumbEvent | HeartbeatEvent | UpdateEvent | ProbeEvent;
