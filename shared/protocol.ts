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

export type CoAppRequest = HlsJobRequest | DirectJobRequest | YtdlpJobRequest | CancelRequest | PingRequest;

export interface PongEvent {
  type: 'pong';
  version: string;
  ffmpeg: boolean;
  ytdlp: boolean;
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

export type CoAppEvent = PongEvent | JobEvent;
