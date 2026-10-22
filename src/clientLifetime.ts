import type { LSPClient, Transport } from "@codemirror/lsp-client";

const lifetimes = new WeakMap<LSPClient, AbortController>();

export function renewClientLifetime(client: LSPClient): AbortSignal {
  let lifetime = lifetimes.get(client);
  if (!lifetime || lifetime.signal.aborted) {
    lifetime = new AbortController();
    lifetimes.set(client, lifetime);
  }
  return lifetime.signal;
}

export function retireClientOperations(client: LSPClient): void {
  lifetimes.get(client)?.abort(new Error("Lean client connection was disconnected."));
}

export function clientLifetimeSignal(client: LSPClient): AbortSignal | undefined {
  return lifetimes.get(client)?.signal;
}

/** Also detects retirement of an upstream client not constructed by this library. */
export function captureClientOperation(client: LSPClient): () => boolean {
  const signal = lifetimes.get(client)?.signal;
  const initializing = client.initializing;
  return () => !signal?.aborted && initializing === client.initializing;
}

/** Own wire requests so retirement settles upstream timers without private registries. */
export class ConnectionTransport implements Transport {
  private active = true;
  private readonly pending = new Map<string | number, ReturnType<typeof setTimeout>>();
  private readonly handlers = new Map<(message: string) => void, (message: string) => void>();

  constructor(private readonly transport: Transport, private readonly timeout = 3000) {}

  private forget(id: string | number): void {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
  }

  send(message: string): void {
    const payload = JSON.parse(message);
    if (!this.active) {
      if (payload.method && (typeof payload.id === "number" || typeof payload.id === "string")) this.cancel(payload.id);
      return;
    }
    if (payload.method && (typeof payload.id === "number" || typeof payload.id === "string")) {
      this.forget(payload.id);
      this.pending.set(payload.id, setTimeout(() => this.pending.delete(payload.id), this.timeout));
    }
    try { this.transport.send(message); }
    catch (error) { this.forget(payload.id); throw error; }
  }

  subscribe(handler: (message: string) => void): void {
    const wrapped = (message: string) => {
      if (!this.active) return;
      try {
        const payload = JSON.parse(message);
        if (!payload.method) this.forget(payload.id);
      } catch { /* Let the upstream client report invalid messages. */ }
      handler(message);
    };
    this.handlers.set(handler, wrapped);
    this.transport.subscribe(wrapped);
  }

  unsubscribe(handler: (message: string) => void): void {
    const wrapped = this.handlers.get(handler);
    if (wrapped) this.transport.unsubscribe(wrapped);
    this.handlers.delete(handler);
  }

  private cancel(id: string | number): void {
    const response = JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32800, message: "Lean client connection was disconnected." },
    });
    for (const handler of this.handlers.keys()) handler(response);
  }

  retire(): void {
    if (!this.active) return;
    this.active = false;
    try {
      for (const id of this.pending.keys()) {
        this.forget(id);
        this.cancel(id);
      }
    } finally {
      for (const wrapped of this.handlers.values()) this.transport.unsubscribe(wrapped);
      // Retain local handlers for already-queued upstream continuations. Their
      // requests receive cancellation immediately, without restarting a timer.
      for (const id of this.pending.keys()) this.forget(id);
    }
  }
}
