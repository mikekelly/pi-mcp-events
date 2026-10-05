export class EventBatcher<T> {
  private pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dropped = 0;
  private weight = 0;
  constructor(
    private deliver: (items: T[], dropped: number) => void,
    private delay = 500,
    private capacity = 256,
    private measure: (item: T) => number = () => 1,
    private maxWeight = Infinity,
  ) {}
  add(item: T) {
    const size = this.measure(item);
    if (
      this.pending.length < this.capacity &&
      this.weight + size <= this.maxWeight
    ) {
      this.pending.push(item);
      this.weight += size;
    } else this.dropped++;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length && !this.dropped) return;
    const items = this.pending;
    const dropped = this.dropped;
    this.pending = [];
    this.dropped = 0;
    this.weight = 0;
    this.deliver(items, dropped);
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.dropped = 0;
    this.weight = 0;
  }
}
