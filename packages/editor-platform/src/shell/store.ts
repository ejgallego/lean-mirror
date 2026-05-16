export type Unsubscribe = () => void;
export type StoreListener<T> = (snapshot: T, previous: T) => void;

export interface SubscribeOptions {
  emitCurrent?: boolean;
}

export class ObservableStore<T> {
  private readonly listeners = new Set<StoreListener<T>>();

  constructor(private current: T) {}

  get snapshot(): T {
    return this.current;
  }

  set(snapshot: T): void {
    const previous = this.current;
    if (Object.is(previous, snapshot)) {
      return;
    }
    this.current = snapshot;
    this.emit(snapshot, previous);
  }

  update(updater: (snapshot: T) => T): void {
    this.set(updater(this.current));
  }

  subscribe(listener: StoreListener<T>, options: SubscribeOptions = {}): Unsubscribe {
    this.listeners.add(listener);
    if (options.emitCurrent) {
      listener(this.current, this.current);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(snapshot: T, previous: T): void {
    for (const listener of [...this.listeners]) {
      listener(snapshot, previous);
    }
  }
}
