import type { AuthoredSnapshot } from "./demoDocuments.js";

export interface SourceReceipt {
  readonly diskRevision: string;
  readonly revision: number;
}
export interface AcknowledgedSource<R extends SourceReceipt> {
  readonly snapshot: AuthoredSnapshot;
  readonly receipt: R;
  readonly currentAtCommit: boolean;
}

/** Serializes committed source receipts and derived work without owning UI state. */
export class SourcePersistence<R extends SourceReceipt> {
  private diskRevision: string;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private scheduled: { timer: ReturnType<typeof setTimeout>; cancel(): void } | null = null;
  constructor(private readonly options: {
    initialDiskRevision: string;
    currentSnapshot(): AuthoredSnapshot | null;
    isCurrent(snapshot: AuthoredSnapshot): boolean;
    save(snapshot: AuthoredSnapshot, expectedDiskRevision: string, sequence: number): Promise<R>;
    delayMs?: number;
  }) { this.diskRevision = options.initialDiskRevision; }

  cancelScheduled(): void {
    this.scheduled?.cancel();
    this.scheduled = null;
  }
  schedule(snapshot: AuthoredSnapshot): Promise<AcknowledgedSource<R> | null> {
    this.cancelScheduled();
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.scheduled = null;
        void this.enqueue(async () => this.options.isCurrent(snapshot) ? this.commit(snapshot) : null).then(resolve, reject);
      }, this.options.delayMs ?? 450);
      this.scheduled = { timer, cancel: () => { clearTimeout(timer); resolve(null); } };
    });
  }
  withSavedSnapshot<T>(action: (saved: AcknowledgedSource<R>) => Promise<T>): Promise<T | null> {
    this.cancelScheduled();
    return this.enqueue(async () => {
      const snapshot = this.options.currentSnapshot();
      if (!snapshot) return null;
      const saved = await this.commit(snapshot);
      if (this.disposed) return null;
      return action(saved);
    });
  }
  private async commit(snapshot: AuthoredSnapshot): Promise<AcknowledgedSource<R>> {
    const receipt = await this.options.save(snapshot, this.diskRevision, ++this.sequence);
    // A successful commit remains acknowledged even if its author has edited again.
    this.diskRevision = receipt.diskRevision;
    return Object.freeze({ snapshot, receipt, currentAtCommit: this.options.isCurrent(snapshot) });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T | null> {
    const result = this.queue.then(() => this.disposed ? null : action());
    this.queue = result.catch(() => undefined);
    return result;
  }
  dispose(): void { this.disposed = true; this.cancelScheduled(); }
}
