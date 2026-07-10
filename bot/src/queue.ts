// FIFO-очередь закачек: параллельные yt-dlp душат канал и диск,
// поэтому качаем строго по одной.

export class SerialQueue {
  private q: Array<() => Promise<unknown> | unknown> = [];
  private running = false;

  constructor(private onError: (e: unknown) => void = () => {}) {}

  /** Возвращает, сколько задач впереди (0 — начнётся сразу) */
  push(task: () => Promise<unknown> | unknown): number {
    const ahead = this.q.length + (this.running ? 1 : 0);
    this.q.push(task);
    void this.pump();
    return ahead;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.q.length > 0) {
      const task = this.q.shift()!;
      try {
        await task();
      } catch (e) {
        this.onError(e);
      }
    }
    this.running = false;
  }
}
