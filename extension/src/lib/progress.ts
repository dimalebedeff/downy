// Форматирование прогресса загрузки для попапа.

export function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export interface JobProgressView {
  /** Текст рядом со шкалой: «45.0 МБ / ~180.0 МБ», «42%», «идёт…» */
  text: string;
  /** Заполнение шкалы 0..1; null — неопределённая шкала */
  ratio: number | null;
}

/** Ниже этого прогресса оценка полного размера слишком шумная — не показываем */
const MIN_PROGRESS_FOR_ESTIMATE = 0.01;

export function jobProgressView(job: { progress: number | null; bytes?: number; totalBytes?: number }): JobProgressView {
  const { progress, bytes, totalBytes } = job;
  if (bytes && totalBytes) {
    return {
      text: `${fmtSize(bytes)} / ${fmtSize(totalBytes)}`,
      ratio: progress ?? Math.min(1, bytes / totalBytes),
    };
  }
  if (bytes && progress != null && progress >= MIN_PROGRESS_FOR_ESTIMATE) {
    // Общий размер неизвестен (HLS) — оцениваем по прогрессу во времени
    return { text: `${fmtSize(bytes)} / ~${fmtSize(bytes / progress)}`, ratio: progress };
  }
  if (bytes) {
    return { text: fmtSize(bytes), ratio: progress };
  }
  if (progress != null) {
    return { text: `${Math.round(progress * 100)}%`, ratio: progress };
  }
  return { text: 'идёт…', ratio: null };
}
