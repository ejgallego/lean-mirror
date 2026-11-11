import { ConnectionScope } from "./connectionScope.js";
import { createLeanEditorSession, createWebSocketTransport, type LeanEditorSessionOptions } from "codemirror-lean4-lsp";
import type { DemoSessionApi, RustSession } from "./demoSession.js";

/** One scope owns allocation, transport, client generation, and backend release. */
export class RustSessionOwner {
  readonly session;
  private info: RustSession | null = null;
  private socket: WebSocket | null = null;
  private disposed = false;
  private readonly scope = new ConnectionScope<{ info: RustSession; socket: WebSocket; client: import("@codemirror/lsp-client").LSPClient }>();
  constructor(private readonly api: Pick<DemoSessionApi, "createRustSession" | "connectWebSocket" | "releaseRustSession">,
    client: LeanEditorSessionOptions["client"]) {
    this.session = createLeanEditorSession({ client: { ...client, features: {
      completion: false, diagnostics: false, hover: false, signatureHelp: false,
      definitionKeymap: false, renameKeymap: false, referencesKeymap: false,
      ...client?.features,
    } } });
  }
  async open(key: string, code: string) {
    return this.scope.open(async () => {
      const deadline = setTimeout(() => this.destroy(), 20_000);
      try {
        const info = await this.api.createRustSession(key, code, this.scope.signal);
        this.info = info;
        this.scope.own(() => { void this.release(); });
        if (this.disposed) { await this.release(); throw new Error("Rust session retired"); }
        const socket = await this.api.connectWebSocket(info.websocketUrl, this.scope.signal);
        this.socket = socket;
        this.scope.own(() => socket.close());
        if (this.disposed) { socket.close(); throw new Error("Rust session retired"); }
        socket.addEventListener("close", () => this.destroy(), { once: true });
        socket.addEventListener("error", () => this.destroy(), { once: true });
        const connection = this.session.connect(createWebSocketTransport(socket), { disposeTransport: () => socket.close() });
        await connection.initialized;
        return { info, socket, client: connection.client };
      } catch (error) { this.destroy(); throw error; }
      finally { clearTimeout(deadline); }
    });
  }
  async analysisReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!this.disposed && Date.now() < deadline) {
      if (await this.session.client?.request("rosetta/ready", {})) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.scope.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 100);
        this.scope.signal.addEventListener("abort", done, { once: true });
      });
    }
    throw new Error("Rust analysis is unavailable or still loading");
  }
  private async release() {
    const info = this.info; this.info = null;
    if (info) await this.api.releaseRustSession(info.key).catch(() => undefined);
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.scope.dispose();
    this.session.dispose();
    this.socket?.close();
    void this.release();
  }
}
