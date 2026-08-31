import type { JobInfo } from './types';

/**
 * Логика очереди загрузок: качается одна (первая по порядку), остальные ждут.
 * Чистые функции — состоянием (order + jobs) владеет background.
 */

export function isUnfinished(state: JobInfo['state']): boolean {
  return state === 'queued' || state === 'starting' || state === 'running' || state === 'paused';
}

/** Чинит порядок после любых изменений: без мёртвых id, новые — в хвост.
 *  Джобы с noQueue (обложки) в очереди не участвуют вовсе. */
export function normalizeOrder(order: string[], jobs: Map<string, JobInfo>): string[] {
  const alive = order.filter((id) => {
    const j = jobs.get(id);
    return j && isUnfinished(j.state) && !j.noQueue;
  });
  const seen = new Set(alive);
  for (const j of jobs.values()) {
    if (isUnfinished(j.state) && !j.noQueue && !seen.has(j.jobId)) alive.push(j.jobId);
  }
  return alive;
}

/**
 * Сколько раз очередь сама поднимет оборвавшуюся загрузку. Потолок нужен,
 * чтобы падающий по кругу хост не перезапускался бесконечно: пара попыток —
 * это уснувший service worker, десяток подряд — это сломанная установка.
 */
export const MAX_AUTO_RESUMES = 3;

/**
 * Кого стартовать, когда активной нет: первый queued, вытесненная пауза либо
 * оборвавшаяся связь. Продолжаются сами обе — ждёт кнопку ▶ только та пауза,
 * которую человек поставил своей рукой.
 */
export function nextToStart(order: string[], jobs: Map<string, JobInfo>): string | undefined {
  for (const id of order) {
    const j = jobs.get(id);
    if (!j) continue;
    if (j.state === 'starting' || j.state === 'running') return undefined;
  }
  for (const id of order) {
    const j = jobs.get(id);
    if (!j) continue;
    if (j.state === 'queued') return id;
    if (j.state === 'paused' && j.pausedBy === 'preempt') return id;
    if (j.state === 'paused' && j.pausedBy === 'dropped' && (j.autoResumes ?? 0) < MAX_AUTO_RESUMES) return id;
  }
  return undefined;
}

/**
 * Полный порядок после перетаскивания видимой части очереди: скрытые
 * строки (их прогресс живёт на карточках) остаются на своих местах,
 * видимые встают в новом порядке.
 */
export function mergeVisibleOrder(full: string[], visible: string[]): string[] {
  const fullSet = new Set(full);
  const replay = visible.filter((id) => fullSet.has(id));
  const moved = new Set(replay);
  let i = 0;
  return full.map((id) => (moved.has(id) ? replay[i++] : id));
}

/**
 * Новый порядок от попапа. Желаемому верим по составу известного:
 * чужие id выкидываем, не упомянутые оставляем в хвосте. Если наверх
 * приехал queued, а качается другой — активную надо вытеснить (пауза).
 */
export function applyReorder(
  current: string[],
  desired: string[],
  jobs: Map<string, JobInfo>,
): { order: string[]; preemptId?: string } {
  const known = new Set(normalizeOrder(current, jobs));
  const order = desired.filter((id) => known.has(id));
  const placed = new Set(order);
  for (const id of known) {
    if (!placed.has(id)) order.push(id);
  }

  let preemptId: string | undefined;
  const head = jobs.get(order[0] ?? '');
  if (head?.state === 'queued') {
    const active = [...jobs.values()].find((j) => j.state === 'running' || j.state === 'starting');
    if (active && active.jobId !== head.jobId) preemptId = active.jobId;
  }
  return { order, preemptId };
}

/**
 * Как зовётся пауза в интерфейсе. Обрыв связи паузой называть нельзя: человек
 * кнопку не жал и будет искать, где он её нажал. Одно состояние — одно слово
 * во всех частях интерфейса.
 */
export function pausedLabel(pausedBy: JobInfo['pausedBy']): string {
  return pausedBy === 'dropped' ? 'оборвалось' : 'пауза';
}

/**
 * Сколько ждать перед новой разведкой сайта, который уже отказал.
 *
 * Попап опрашивает фон каждые две секунды, и на сломанном сайте плоская
 * минута превращалась в процесс качалки каждые полторы минуты всё время,
 * пока открыт попап. Сайту, который отвечает бот-чеком, мы этим только
 * подливаем: чем чаще стучим, тем дольше он не пускает.
 */
export function probeRetryDelay(failures: number): number {
  const minute = 60_000;
  const steps = [minute, 5 * minute, 15 * minute, 30 * minute];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1];
}
