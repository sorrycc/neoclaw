export class MediaQueue {
  private items: string[] = [];

  push(path: string): void {
    this.items.push(path);
  }

  drain(): string[] {
    return this.items.splice(0);
  }

  get length(): number {
    return this.items.length;
  }
}
