// Протокол сообщений между расширением и CoApp (Native Messaging).

export interface HlsJobRequest {
  type: 'download_hls';
  jobId: string;
  /** URL медиа-плейлиста или выбранного варианта из мастер-плейлиста */
  url: string;
  /** Имя файла с расширением, уже безопасное для файловой системы */
  filename: string;
  /** Папка сохранения; пусто — Downloads\downy */
  outDir?: string;
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
}

export interface CancelRequest {
  type: 'cancel';
  jobId: string;
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
  | CancelRequest
  | PingRequest
  | PickDirRequest
  | ThumbRequest;

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

export type JobState = 'running' | 'done' | 'error' | 'canceled';

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

export type CoAppEvent = PongEvent | JobEvent | PickDirEvent | ThumbEvent | HeartbeatEvent;
