// Форматирование прогресса загрузки для попапа.

export function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** «12.4 МБ/с»; совсем мелкую или неизвестную скорость не показываем */
export function fmtSpeed(bps?: number): string {
  if (!bps || bps < 1024) return '';
  return `${fmtSize(bps)}/с`;
}

/** «1:20» / «1:05:00»; нет данных или мусор — пустая строка */
export function fmtEta(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.max(1, Math.round(sec));
  if (s > 100 * 3600) return ''; // оценка на сотни часов — враньё, не позоримся
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export interface JobProgressView {
  /** Текст рядом со шкалой: «45% · 12.4 МБ/с · ост. 1:20», «42%», «идёт…» */
  text: string;
  /** Заполнение шкалы 0..1; null — неопределённая шкала */
  ratio: number | null;
}

/** Ниже этого прогресса оценка полного размера слишком шумная — не показываем */
const MIN_PROGRESS_FOR_ESTIMATE = 0.01;

export function jobProgressView(
  job: { progress: number | null; bytes?: number; totalBytes?: number; speedBps?: number },
): JobProgressView {
  const { progress, bytes, totalBytes, speedBps } = job;
  let ratio: number | null = null;
  let total = totalBytes;
  if (bytes && totalBytes) {
    ratio = progress ?? Math.min(1, bytes / totalBytes);
  } else if (progress != null) {
    ratio = progress;
    // Общий размер неизвестен (HLS) — оцениваем по прогрессу во времени
    if (bytes && progress >= MIN_PROGRESS_FOR_ESTIMATE) total = bytes / progress;
  }

  const speed = fmtSpeed(speedBps);
  if (speed) {
    // Скорость известна — компактно: процент, скорость, остаток
    const head = ratio != null ? `${Math.round(ratio * 100)}%` : fmtSize(bytes) || 'идёт…';
    const parts = [head, speed];
    const eta = fmtEta(bytes && total && speedBps ? (total - bytes) / speedBps : undefined);
    if (eta) parts.push(`ост. ${eta}`);
    return { text: parts.join(' · '), ratio };
  }

  if (bytes && totalBytes) {
    return { text: `${fmtSize(bytes)} / ${fmtSize(totalBytes)}`, ratio };
  }
  if (bytes && total && total !== totalBytes) {
    return { text: `${fmtSize(bytes)} / ~${fmtSize(total)}`, ratio };
  }
  if (bytes) {
    return { text: fmtSize(bytes), ratio: progress };
  }
  if (progress != null) {
    return { text: `${Math.round(progress * 100)}%`, ratio: progress };
  }
  return { text: 'идёт…', ratio: null };
}
