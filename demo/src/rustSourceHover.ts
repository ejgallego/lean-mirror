import type { LSPClient } from "@codemirror/lsp-client";
import type { EditorState, Extension } from "@codemirror/state";
import { hoverTooltip, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  createLeanEditorSession, createLeanWorkspace, createWebSocketTransport,
  type LeanEditorSession, type LeanLspClientExtension, type LeanServerDocumentLease, type LeanWorkspace,
} from "codemirror-lean4-lsp";
import type * as lsp from "vscode-languageserver-protocol";
import type { DemoSessionApi } from "./demoSession.js";
import type { EmbeddedBlock } from "./embeddedBlocks.js";
import { normalizeRustHover, rustHoverDom } from "./rustHover.js";

type RustSessionApi = Pick<DemoSessionApi, "createRustSession" | "connectWebSocket">;

/** The host routes body hovers to Rust instead of displaying Lean's code-block help too. */
export function filterLeanHovers(ownedByRust: (params: lsp.HoverParams) => boolean): LeanLspClientExtension {
  return { wrapTransport(transport) {
    const handlers = new Set<(message: string) => void>();
    return {
      send(message) {
        const request = JSON.parse(message);
        if (request.method === "textDocument/hover" && ownedByRust(request.params)) {
          const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null });
          queueMicrotask(() => { for (const handler of handlers) handler(response); });
        } else transport.send(message);
      },
      subscribe(handler) { handlers.add(handler); transport.subscribe(handler); },
      unsubscribe(handler) { handlers.delete(handler); transport.unsubscribe(handler); },
    };
  } };
}

/** Only body lines belong to Rust: fences and surrounding prose stay in Lean. */
export function rustPositionAt(block: EmbeddedBlock, offset: number): lsp.Position | null {
  const lines = block.code.split("\n");
  for (const [line, start] of (block.codeLineStarts ?? []).entries()) {
    const character = offset - start;
    if (character >= 0 && character <= lines[line]!.length) return { line, character };
  }
  return null;
}

export function rustPositionInSource(block: EmbeddedBlock, position: lsp.Position): number | null {
  const start = block.codeLineStarts?.[position.line];
  const line = block.code.split("\n")[position.line];
  return start === undefined || line === undefined || position.character < 0 || position.character > line.length
    ? null : start + position.character;
}

/** A server document lease supplies an overlay without mounting another editor. */
export class RustSourceSession {
  private readonly session: LeanEditorSession;
  private readonly ready: Promise<LSPClient | null>;
  private workspace: LeanWorkspace | null = null;
  private lease: LeanServerDocumentLease | null = null;
  private socket: WebSocket | null = null;
  private documentUri: string | null = null;
  private disposed = false;
  private revision = 0;

  constructor(
    private readonly api: RustSessionApi,
    readonly key: string,
    private code: string,
  ) {
    this.session = createLeanEditorSession({ client: {
      features: { completion: false, diagnostics: false, hover: false, signatureHelp: false,
        definitionKeymap: false, renameKeymap: false, referencesKeymap: false },
      timeout: 15000,
      workspace: client => this.workspace = createLeanWorkspace({
        loadDocument: uri => uri === this.documentUri ? { doc: this.code, languageId: "rust" } : null,
      })(client),
    } });
    this.ready = this.open().catch(error => { this.destroy(); throw error; });
    // A view can close before any hover caller starts awaiting initialization.
    void this.ready.catch(() => undefined);
  }

  get closed(): boolean { return this.disposed; }

  private async open(): Promise<LSPClient | null> {
    const info = await this.api.createRustSession(this.key, this.code);
    if (this.disposed) return null;
    this.documentUri = info.documentUri;
    const socket = await this.api.connectWebSocket(info.websocketUrl);
    if (this.disposed) { socket.close(); return null; }
    this.socket = socket;
    socket.addEventListener("close", () => this.destroy(), { once: true });
    socket.addEventListener("error", () => this.destroy(), { once: true });
    const connection = this.session.connect(createWebSocketTransport(socket), {
      disposeTransport: () => socket.close(),
    });
    await connection.initialized;
    const lease = await this.workspace!.acquireServerDocument(info.documentUri);
    if (this.disposed) { lease?.release(); return null; }
    if (!lease) throw new Error("Cannot open the Rust source overlay.");
    this.lease = lease;
    this.sync();
    return connection.client;
  }

  private sync(): void {
    if (!this.lease || !this.workspace || !this.documentUri || this.disposed) return;
    const file = this.lease.file;
    if (file.doc.toString() !== this.code) this.workspace.updateFile(this.documentUri, {
      changes: { from: 0, to: file.doc.length, insert: this.code },
    });
    this.session.client?.sync();
  }

  setCode(code: string): void {
    if (code === this.code || this.disposed) return;
    this.code = code;
    this.revision++;
    this.sync();
  }

  async hover(position: lsp.Position): Promise<lsp.Hover | null> {
    const revision = this.revision;
    const client = await this.ready;
    if (!client || this.disposed || revision !== this.revision) return null;
    this.sync();
    const result = await client.request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
      position, textDocument: { uri: this.documentUri! },
    });
    return this.disposed || revision !== this.revision ? null : result;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lease?.release();
    this.session.dispose();
    this.socket?.close();
  }
}

export function rustSourceHover(
  api: DemoSessionApi,
  parse: (source: string) => EmbeddedBlock[],
  visible: (state: EditorState, block: EmbeddedBlock) => boolean,
): Extension {
  // One lazily opened Rust session per host view bounds resource use even when
  // the document contains many fences. Moving to another fence retires it.
  const sessions = ViewPlugin.define(() => ({
    current: null as RustSourceSession | null,
    update(update: ViewUpdate) {
      if (!this.current) return;
      const block = parse(update.state.doc.toString()).find(block => block.key === this.current!.key);
      if (!block || !visible(update.state, block)) this.destroy();
      else this.current.setCode(block.code);
    },
    destroy() { this.current?.destroy(); this.current = null; },
  }));
  return [sessions, hoverTooltip(async (view, pos) => {
    const doc = view.state.doc;
    const block = parse(doc.toString()).find(block => visible(view.state, block) && rustPositionAt(block, pos));
    if (!block) return null;
    const position = rustPositionAt(block, pos)!;
    const owner = view.plugin(sessions);
    if (!owner) return null;
    if (!owner.current || owner.current.closed || owner.current.key !== block.key) {
      owner.current?.destroy();
      owner.current = new RustSourceSession(api, block.key, block.code);
    }
    const session = owner.current;
    const current = () => view.state.doc === doc && owner.current === session && !session.closed;
    try {
      // Rust can initially return null while its new Cargo workspace loads.
      for (let attempt = 0; attempt < 12 && current(); attempt++) {
        const result = await session.hover(position);
        if (!current()) return null;
        if (result) {
          const contents = normalizeRustHover(result.contents);
          const from = result.range ? rustPositionInSource(block, result.range.start) : pos;
          const to = result.range ? rustPositionInSource(block, result.range.end) : pos;
          if (!contents || from === null || to === null || from > pos || to < pos) return null;
          return { pos: from, end: to, above: true, create: () => ({ dom: rustHoverDom(view, contents) }) };
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch { /* A stale overlay or closed view must not surface an old hover. */ }
    return null;
  }, { hideOn: transaction => transaction.docChanged })];
}
