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
  private readonly pending = new Set<string | number>();
  private readonly handlers = new Map<(message: string) => void, (message: string) => void>();

  constructor(private readonly transport: Transport) {}

  send(message: string): void {
    if (!this.active) return;
    const payload = JSON.parse(message);
    if (payload.method && (typeof payload.id === "number" || typeof payload.id === "string")) {
      this.pending.add(payload.id);
    }
    this.transport.send(message);
  }

  subscribe(handler: (message: string) => void): void {
    const wrapped = (message: string) => {
      if (!this.active) return;
      try {
        const payload = JSON.parse(message);
        if (!payload.method) this.pending.delete(payload.id);
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

  retire(): void {
    if (!this.active) return;
    this.active = false;
    for (const id of this.pending) {
      const response = JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32800, message: "Lean client connection was disconnected." },
      });
      for (const handler of this.handlers.keys()) handler(response);
    }
    this.pending.clear();
  }
}
