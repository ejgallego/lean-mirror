/** A generation owns every acquisition, including resources arriving after retirement. */
export class ConnectionScope<T> {
  private static nextGeneration = 0;
  readonly generation = ++ConnectionScope.nextGeneration;
  private readonly abort = new AbortController();
  private cleanups: (() => void)[] = [];
  private pending: Promise<T> | null = null;
  private retired = false;
  get signal(): AbortSignal { return this.abort.signal; }
  get disposed(): boolean { return this.retired; }
  own(cleanup: () => void): void {
    if (this.retired) cleanup();
    else this.cleanups.push(cleanup);
  }
  open(acquire: () => Promise<T>): Promise<T> {
    if (this.retired) return Promise.reject(new Error("Connection generation retired"));
    if (this.pending) return this.pending;
    let stop!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("Connection generation retired"));
      this.signal.addEventListener("abort", stop, { once: true });
    });
    this.pending = Promise.race([Promise.resolve().then(() => {
      if (this.retired) throw new Error("Connection generation retired");
      return acquire();
    }), aborted]).then(value => {
      if (this.retired) throw new Error("Connection generation retired");
      return value;
    }).catch(error => { this.dispose(); throw error; })
      .finally(() => this.signal.removeEventListener("abort", stop));
    return this.pending;
  }
  dispose(): void {
    if (this.retired) return;
    this.retired = true;
    this.abort.abort();
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { cleanup(); } catch (error) { console.error("Connection cleanup failed", error); }
    }
  }
}
