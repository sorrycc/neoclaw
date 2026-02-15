export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buffer.push(item);
    }
  }

  async pop(): Promise<T> {
    const item = this.buffer.shift();
    if (item !== undefined) return item;
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}
