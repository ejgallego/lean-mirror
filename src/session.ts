import {
  type LSPClient,
  type LSPClientExtension,
  type Transport,
} from "@codemirror/lsp-client";

import { createLeanLspClient, type LeanLspClientConfig } from "./client.js";

export type LeanEditorSessionPhase =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "disposed";

export interface LeanEditorSessionState {
  readonly error?: unknown;
  readonly generation: number;
  readonly phase: LeanEditorSessionPhase;
}

export type LeanEditorSessionStateListener = (
  state: LeanEditorSessionState,
) => void;

export interface LeanEditorSessionSubscriptionOptions {
  emitCurrent?: boolean;
}

/**
 * An LSP client extension that owns state tied to one server connection.
 *
 * The session invokes this hook before disconnecting a client generation.
 * Direct users of `createLeanLspClient` own this cleanup themselves.
 */
export interface LeanEditorSessionExtension extends LSPClientExtension {
  onSessionDisconnect?(client: LSPClient): void;
}

export interface LeanEditorSessionOptions {
  client?: LeanLspClientConfig;
  onStateChange?: LeanEditorSessionStateListener;
}

export interface LeanEditorSessionConnectOptions {
  /** Release resources owned by the embedding application's transport. */
  disposeTransport?: () => void;
}

export interface LeanEditorConnection {
  readonly client: LSPClient;
  readonly generation: number;
  readonly initialized: Promise<LSPClient>;
  disconnect(): void;
}

interface ActiveConnection {
  readonly connection: LeanEditorConnection;
  readonly disposeTransport?: () => void;
  readonly lifecycleExtensions: readonly LeanEditorSessionExtension[];
  rejectInitialization(reason: unknown): void;
}

export class LeanEditorSessionDisconnectedError extends Error {
  constructor(generation: number) {
    super(`Lean editor session generation ${generation} disconnected before initialization.`);
    this.name = "LeanEditorSessionDisconnectedError";
  }
}

function hasSessionLifecycle(
  extension: unknown,
): extension is LeanEditorSessionExtension {
  return (
    !!extension &&
    typeof extension === "object" &&
    !Array.isArray(extension) &&
    typeof (extension as LeanEditorSessionExtension).onSessionDisconnect === "function"
  );
}

/**
 * Owns client generations and their connection-scoped cleanup.
 *
 * Reconnection deliberately creates a fresh `LSPClient`. Mounted editors can
 * follow new client generations through `leanEditorSessionBinding()`.
 */
export class LeanEditorSession {
  private active: ActiveConnection | null = null;
  private generation = 0;
  private readonly stateListeners = new Set<LeanEditorSessionStateListener>();
  private sessionState: LeanEditorSessionState = {
    generation: 0,
    phase: "idle",
  };

  constructor(private readonly options: LeanEditorSessionOptions = {}) {}

  get client(): LSPClient | null {
    return this.active?.connection.client ?? null;
  }

  get connection(): LeanEditorConnection | null {
    return this.active?.connection ?? null;
  }

  get state(): LeanEditorSessionState {
    return this.sessionState;
  }

  subscribe(
    listener: LeanEditorSessionStateListener,
    options: LeanEditorSessionSubscriptionOptions = {},
  ): () => void {
    this.stateListeners.add(listener);
    if (options.emitCurrent) {
      listener(this.sessionState);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  connect(
    transport: Transport,
    options: LeanEditorSessionConnectOptions = {},
  ): LeanEditorConnection {
    if (this.sessionState.phase === "disposed") {
      throw new Error("Cannot connect a disposed Lean editor session.");
    }
    if (this.active) {
      throw new Error("Lean editor session is already connected; use reconnect().");
    }

    const generation = ++this.generation;
    const clientConfig = this.options.client ?? {};
    const client = createLeanLspClient(clientConfig);
    const lifecycleExtensions = (clientConfig.extensions ?? []).filter(hasSessionLifecycle);

    let rejectInitialization!: (reason: unknown) => void;
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectInitialization = reject;
    });
    const initialized = Promise.race([
      client.initializing.then(() => client),
      disconnected,
    ]);
    const connection: LeanEditorConnection = {
      client,
      generation,
      initialized,
      disconnect: () => {
        this.disconnectConnection(active);
      },
    };
    const active: ActiveConnection = {
      connection,
      lifecycleExtensions,
      rejectInitialization,
      ...(options.disposeTransport ? { disposeTransport: options.disposeTransport } : {}),
    };
    this.active = active;
    this.setState({ generation, phase: "initializing" });

    void initialized.then(
      () => {
        if (this.active === active) {
          this.setState({ generation, phase: "ready" });
        }
      },
      (error: unknown) => {
        if (this.active === active) {
          this.setState({ error, generation, phase: "failed" });
        }
      },
    );

    try {
      client.connect(transport);
    } catch (error) {
      this.disconnectConnection(active);
      this.setState({ error, generation, phase: "failed" });
      throw error;
    }

    return connection;
  }

  reconnect(
    transport: Transport,
    options: LeanEditorSessionConnectOptions = {},
  ): LeanEditorConnection {
    if (this.sessionState.phase === "disposed") {
      throw new Error("Cannot reconnect a disposed Lean editor session.");
    }
    this.disconnect();
    return this.connect(transport, options);
  }

  disconnect(): void {
    if (!this.active) {
      return;
    }
    this.disconnectConnection(this.active);
  }

  dispose(): void {
    if (this.sessionState.phase === "disposed") {
      return;
    }
    try {
      if (this.active) {
        this.disconnectConnection(this.active, "disposed");
      } else {
        this.setState({ generation: this.generation, phase: "disposed" });
      }
    } finally {
      this.stateListeners.clear();
    }
  }

  private disconnectConnection(
    active: ActiveConnection,
    nextPhase: "idle" | "disposed" = "idle",
  ): void {
    if (this.active !== active) {
      return;
    }
    this.active = null;
    active.rejectInitialization(
      new LeanEditorSessionDisconnectedError(active.connection.generation),
    );

    let firstError: unknown;
    try {
      // Session-aware editor bindings detach here, while the old client can
      // still send its final didClose notifications through the transport.
      this.setState({
        generation: active.connection.generation,
        phase: nextPhase,
      });
    } catch (error) {
      firstError ??= error;
    }
    for (const extension of active.lifecycleExtensions) {
      try {
        extension.onSessionDisconnect?.(active.connection.client);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      active.connection.client.disconnect();
    } catch (error) {
      firstError ??= error;
    }
    try {
      active.disposeTransport?.();
    } catch (error) {
      firstError ??= error;
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private setState(state: LeanEditorSessionState): void {
    this.sessionState = state;
    this.options.onStateChange?.(state);
    for (const listener of [...this.stateListeners]) {
      listener(state);
    }
  }
}

export function createLeanEditorSession(
  options: LeanEditorSessionOptions = {},
): LeanEditorSession {
  return new LeanEditorSession(options);
}
