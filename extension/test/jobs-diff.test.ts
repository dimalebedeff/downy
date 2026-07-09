import { describe, expect, it } from 'vitest';
import { diffJobs } from '../src/lib/jobs-diff';
import type { JobInfo } from '../src/lib/types';

function job(over: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: 'j1',
    label: 'video.mp4',
    state: 'running',
    progress: 0.5,
    bytes: 100,
    totalBytes: 200,
    ...over,
  };
}

describe('diffJobs', () => {
  it('одинаковые списки — same', () => {
    expect(diffJobs([job()], [job()])).toBe('same');
    expect(diffJobs([], [])).toBe('same');
  });

  it('изменились только цифры прогресса — progress', () => {
    expect(diffJobs([job()], [job({ progress: 0.7, bytes: 140 })])).toBe('progress');
    expect(diffJobs([job({ totalBytes: undefined })], [job({ totalBytes: 200 })])).toBe('progress');
    expect(diffJobs([job({ progress: null, bytes: undefined })], [job()])).toBe('progress');
  });

  it('новая или пропавшая загрузка — structural', () => {
    expect(diffJobs([], [job()])).toBe('structural');
    expect(diffJobs([job()], [])).toBe('structural');
    expect(diffJobs([job()], [job(), job({ jobId: 'j2' })])).toBe('structural');
  });

  it('смена состояния — structural', () => {
    expect(diffJobs([job()], [job({ state: 'done', outFile: 'C:\\out\\video.mp4' })])).toBe('structural');
    expect(diffJobs([job({ state: 'starting' })], [job()])).toBe('structural');
  });

  it('смена состава при том же размере — structural', () => {
    expect(diffJobs([job()], [job({ jobId: 'j2' })])).toBe('structural');
  });

  it('изменение сообщения или файла — structural', () => {
    expect(diffJobs([job()], [job({ message: 'ошибка сети' })])).toBe('structural');
    expect(diffJobs([job()], [job({ outFile: 'C:\\out\\video.mp4' })])).toBe('structural');
    expect(diffJobs([job()], [job({ label: 'other.mp4' })])).toBe('structural');
  });
});
