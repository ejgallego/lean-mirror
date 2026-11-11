import { createLeanEditorSession, createWebSocketTransport, type LeanEditorSessionOptions } from "codemirror-lean4-lsp";
import type { DemoSessionApi, RustSession } from "./demoSession.js";

/** One scope owns allocation, transport, client generation, and backend release. */
export class RustSessionOwner {
  readonly session;
  private info: RustSession | null = null;
  private socket: WebSocket | null = null;
  private disposed = false;
  private readonly abort = new AbortController();
  constructor(private readonly api: Pick<DemoSessionApi, "createRustSession" | "connectWebSocket" | "releaseRustSession">,
    client: LeanEditorSessionOptions["client"]) {
    this.session = createLeanEditorSession({ client: { ...client, features: {
      completion: false, diagnostics: false, hover: false, signatureHelp: false,
      definitionKeymap: false, renameKeymap: false, referencesKeymap: false,
      ...client?.features,
    } } });
  }
  async open(key: string, code: string) {
    const deadline = setTimeout(() => this.destroy(), 20_000);
    try {
      const info = await this.api.createRustSession(key, code, this.abort.signal);
      this.info = info;
      if (this.disposed) { await this.release(); throw new Error("Rust session retired"); }
      const socket = await this.api.connectWebSocket(info.websocketUrl, this.abort.signal);
      this.socket = socket;
      if (this.disposed) { socket.close(); throw new Error("Rust session retired"); }
      socket.addEventListener("close", () => this.destroy(), { once: true });
      socket.addEventListener("error", () => this.destroy(), { once: true });
      const connection = this.session.connect(createWebSocketTransport(socket), { disposeTransport: () => socket.close() });
      await connection.initialized;
      return { info, socket, client: connection.client };
    } catch (error) { this.destroy(); throw error; }
    finally { clearTimeout(deadline); }
  }
  async analysisReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!this.disposed && Date.now() < deadline) {
      if (await this.session.client?.request("rosetta/ready", {})) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 100);
        this.abort.signal.addEventListener("abort", done, { once: true });
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
    this.abort.abort();
    this.session.dispose();
    this.socket?.close();
    void this.release();
  }
}
