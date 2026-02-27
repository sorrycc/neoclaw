export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buffer.push(item);
    }
  }

  async pop(): Promise<T | undefined> {
    if (this.closed) return undefined;
    const item = this.buffer.shift();
    if (item !== undefined) return item;
    if (this.closed) return undefined;
    return new Promise<T | undefined>((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter(undefined);
    this.waiters.length = 0;
  }
}
