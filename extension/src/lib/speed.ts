// Скорость загрузки: EMA по дельтам байтов между событиями хоста,
// чтобы цифра в попапе не дёргалась на каждом чанке.

export interface SpeedTrack {
  /** Байты на момент последнего замера */
  bytes: number;
  /** Время замера, мс */
  at: number;
  /** Сглаженная скорость, байт/с; нет — мало данных */
  bps?: number;
}

/** Вес свежего замера в EMA: выше — живее реагирует, ниже — ровнее цифра */
const ALPHA = 0.3;

/** Новый трек по свежему замеру. Откат байтов (резюм с Range) — начинаем заново. */
export function nextSpeed(prev: SpeedTrack | undefined, bytes: number, at: number): SpeedTrack {
  if (!prev || bytes < prev.bytes) return { bytes, at };
  const dtMs = at - prev.at;
  if (dtMs <= 0) return prev.bytes === bytes ? prev : { ...prev, bytes };
  const inst = ((bytes - prev.bytes) * 1000) / dtMs;
  const bps = prev.bps == null ? inst : prev.bps + ALPHA * (inst - prev.bps);
  return { bytes, at, bps };
}
