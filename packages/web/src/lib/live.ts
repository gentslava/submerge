export class RingBuffer<T> {
  private readonly capacity: number;
  private items: T[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  toArray(): readonly T[] {
    return this.items;
  }
}
