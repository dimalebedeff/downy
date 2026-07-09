import type { JobInfo } from './types';

/**
 * Насколько изменился список загрузок:
 * 'same' — ничего; 'progress' — только цифры (ширину шкалы можно обновить
 * на месте); 'structural' — состав/состояния, нужна перерисовка карточек.
 */
export type JobsDiff = 'same' | 'progress' | 'structural';

export function diffJobs(prev: JobInfo[], next: JobInfo[]): JobsDiff {
  if (prev.length !== next.length) return 'structural';
  let progressChanged = false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.jobId !== b.jobId ||
      a.state !== b.state ||
      a.label !== b.label ||
      a.message !== b.message ||
      a.outFile !== b.outFile
    ) {
      return 'structural';
    }
    if (a.progress !== b.progress || a.bytes !== b.bytes || a.totalBytes !== b.totalBytes) {
      progressChanged = true;
    }
  }
  return progressChanged ? 'progress' : 'same';
}
