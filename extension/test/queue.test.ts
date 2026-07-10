import { describe, expect, it } from 'vitest';
import { applyReorder, isUnfinished, mergeVisibleOrder, nextToStart, normalizeOrder } from '../src/lib/queue';
import type { JobInfo } from '../src/lib/types';

function job(jobId: string, state: JobInfo['state'], pausedBy?: 'user' | 'preempt'): JobInfo {
  return { jobId, label: jobId, state, progress: null, pausedBy };
}

function jobsMap(...list: JobInfo[]): Map<string, JobInfo> {
  return new Map(list.map((j) => [j.jobId, j]));
}

describe('isUnfinished', () => {
  it('очередь — это queued/starting/running/paused', () => {
    expect(isUnfinished('queued')).toBe(true);
    expect(isUnfinished('starting')).toBe(true);
    expect(isUnfinished('running')).toBe(true);
    expect(isUnfinished('paused')).toBe(true);
    expect(isUnfinished('done')).toBe(false);
    expect(isUnfinished('error')).toBe(false);
    expect(isUnfinished('canceled')).toBe(false);
  });
});

describe('normalizeOrder', () => {
  it('выкидывает завершённые и незнакомые, дописывает новые в хвост', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'done'), job('c', 'queued'), job('d', 'queued'));
    expect(normalizeOrder(['b', 'a', 'ghost', 'c'], jobs)).toEqual(['a', 'c', 'd']);
  });

  it('пустой порядок — все незавершённые по порядку появления', () => {
    const jobs = jobsMap(job('a', 'queued'), job('b', 'done'), job('c', 'paused'));
    expect(normalizeOrder([], jobs)).toEqual(['a', 'c']);
  });

  it('noQueue (обложки) в очередь не попадают', () => {
    const cover: JobInfo = { ...job('t', 'running'), noQueue: true };
    const jobs = new Map([['t', cover], ['a', job('a', 'queued')]]);
    expect(normalizeOrder(['t'], jobs)).toEqual(['a']);
  });
});

describe('nextToStart', () => {
  it('ничего, пока есть активная', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'queued'));
    expect(nextToStart(['a', 'b'], jobs)).toBeUndefined();
    const jobs2 = jobsMap(job('a', 'starting'), job('b', 'queued'));
    expect(nextToStart(['a', 'b'], jobs2)).toBeUndefined();
  });

  it('первый queued по порядку', () => {
    const jobs = jobsMap(job('a', 'paused', 'user'), job('b', 'queued'), job('c', 'queued'));
    expect(nextToStart(['a', 'b', 'c'], jobs)).toBe('b');
  });

  it('ручную паузу не трогает, вытесненную возобновляет', () => {
    const user = jobsMap(job('a', 'paused', 'user'));
    expect(nextToStart(['a'], user)).toBeUndefined();
    const preempt = jobsMap(job('a', 'paused', 'preempt'), job('b', 'queued'));
    expect(nextToStart(['a', 'b'], preempt)).toBe('a');
  });

  it('пустая очередь — некого стартовать', () => {
    expect(nextToStart([], jobsMap())).toBeUndefined();
  });
});

describe('mergeVisibleOrder', () => {
  it('видимые строки встают в новом порядке, скрытые не двигаются', () => {
    // a скрыта (её прогресс на карточке), b и c поменяли местами
    expect(mergeVisibleOrder(['a', 'b', 'c'], ['c', 'b'])).toEqual(['a', 'c', 'b']);
  });

  it('скрытая активная остаётся во главе — реордер хвоста её не вытесняет', () => {
    expect(mergeVisibleOrder(['active', 'b', 'c', 'd'], ['d', 'b', 'c'])).toEqual(['active', 'd', 'b', 'c']);
  });

  it('все видимы — просто новый порядок', () => {
    expect(mergeVisibleOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a']);
  });

  it('незнакомые видимые id выкидываются, порядок остальных соблюдается', () => {
    expect(mergeVisibleOrder(['a', 'b'], ['ghost', 'b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('applyReorder', () => {
  it('принимает новый порядок ждущих', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'queued'), job('c', 'queued'));
    const res = applyReorder(['a', 'b', 'c'], ['a', 'c', 'b'], jobs);
    expect(res.order).toEqual(['a', 'c', 'b']);
    expect(res.preemptId).toBeUndefined();
  });

  it('queued выше активной — вытеснение', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'queued'));
    const res = applyReorder(['a', 'b'], ['b', 'a'], jobs);
    expect(res.order).toEqual(['b', 'a']);
    expect(res.preemptId).toBe('a');
  });

  it('пауза юзера выше активной — вытеснения нет', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'paused', 'user'));
    const res = applyReorder(['a', 'b'], ['b', 'a'], jobs);
    expect(res.order).toEqual(['b', 'a']);
    expect(res.preemptId).toBeUndefined();
  });

  it('фильтрует чужие id и дописывает пропавшие из желаемого', () => {
    const jobs = jobsMap(job('a', 'running'), job('b', 'queued'), job('c', 'queued'));
    // Попап не знал про свежий c — тот остаётся в хвосте; ghost выкидываем
    const res = applyReorder(['a', 'b', 'c'], ['ghost', 'b', 'a'], jobs);
    expect(res.order).toEqual(['b', 'a', 'c']);
  });
});
