import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src/queue';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SerialQueue', () => {
  it('выполняет задачи по одной, в порядке добавления', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    let release1!: () => void;
    const gate = new Promise<void>((r) => (release1 = r));

    q.push(async () => {
      order.push(1);
      await gate;
    });
    q.push(async () => {
      order.push(2);
    });
    await tick();
    expect(order).toEqual([1]); // вторая ждёт первую
    release1();
    await tick();
    await tick();
    expect(order).toEqual([1, 2]);
  });

  it('push возвращает число задач впереди', async () => {
    const q = new SerialQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    expect(q.push(() => gate)).toBe(0);
    expect(q.push(async () => {})).toBe(1);
    expect(q.push(async () => {})).toBe(2);
    release();
    await tick();
    await tick();
    await tick();
    expect(q.push(async () => {})).toBe(0);
  });

  it('упавшая задача не валит очередь', async () => {
    const errors: unknown[] = [];
    const q = new SerialQueue((e) => errors.push(e));
    const order: number[] = [];
    q.push(async () => {
      throw new Error('бах');
    });
    q.push(async () => {
      order.push(2);
    });
    await tick();
    await tick();
    expect(order).toEqual([2]);
    expect(errors).toHaveLength(1);
  });
});
