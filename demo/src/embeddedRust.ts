import type { Extension } from "@codemirror/state";
import { Compartment, EditorState } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  LSPClient,
  LSPPlugin,
  type LSPClientExtension,
  findReferencesKeymap,
  formatKeymap,
  jumpToDefinitionKeymap,
  renameKeymap,
  serverCompletion,
  signatureHelp,
} from "@codemirror/lsp-client";
import { createWebSocketTransport, leanUtilities } from "codemirror-lean4-lsp";
import { EditorView, hoverTooltip, keymap, type Tooltip } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type * as lsp from "vscode-languageserver-protocol";
import {
  createVersoCommentAdapter,
  type EmbeddedBlockInlineCreateOptions,
  type EmbeddedBlock,
  type EmbeddedBlockInlineHandle,
} from "./embeddedBlocks.js";
import type { DemoSessionApi } from "./demoSession.js";
import { sanitizeHtml } from "./sanitizeHtml.js";
import { renderRustPreview, type RustPreviewToken } from "./rustPreview.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

const baseRustAdapter = createVersoCommentAdapter<EmbeddedRustBlock>({
  defaultTitle(block) {
    return block.label?.match(/^\(name\s*:=\s*«?([^»)]*)»?\)$/)?.[1] ?? block.label ?? `Rust Block ${block.ordinal}`;
  },
  displayName: "Rust",
  editorExtensions(): Extension[] {
    return [
      rust(),
      ...leanUtilities({
        activeLine: false,
        defaultKeymap: true,
        drawSelection: true,
        foldGutter: false,
        foldKeymap: false,
        history: true,
        historyKeymap: true,
        indentWithTab: true,
        lineNumbers: false,
        lineWrapping: true,
        search: false,
        searchKeymap: false,
      }),
    ];
  },
  hostLanguageIds: ["lean4"],
  kind: "rust",
  scaffold: {
    baseLabel: "demoWidget",
    createBlock(label) {
      return { code: "", from: 0, to: 0, ordinal: 0, title: label,
        key: `rust:${label}`, label: `(name := «${label}»)` };
    },
    code() {
      return ['fn demo() {', '    println!("hello from Rust");', '}'].join("\n");
    },
  },
});

function stripRustHoverPrefix(text: string): string {
  return text.replace(/^(?:widget|embedded_[a-z0-9_]+)\r?\n\r?\n/, "");
}

function normalizeRustHover(
  contents: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
): lsp.MarkupContent | null {
  if (Array.isArray(contents)) {
    const parts = contents
      .map((item) => normalizeRustHover(item))
      .filter((item): item is lsp.MarkupContent => item !== null)
      .map((item) => item.value);
    return parts.length > 0 ? { kind: "markdown", value: parts.join("\n\n") } : null;
  }
  if (typeof contents === "string") {
    return { kind: "markdown", value: stripRustHoverPrefix(contents) };
  }
  if ("language" in contents) {
    return {
      kind: "markdown",
      value: `\`\`\`${contents.language}\n${stripRustHoverPrefix(contents.value)}\n\`\`\``,
    };
  }
  return {
    kind: contents.kind,
    value: stripRustHoverPrefix(contents.value),
  };
}

function hoverErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : null;
  }
  const candidate = error as { code?: unknown; message?: unknown; error?: unknown };
  if (typeof candidate.message === "string") {
    return candidate.message;
  }
  if (candidate.error && typeof candidate.error === "object" && "message" in candidate.error) {
    const inner = candidate.error as { message?: unknown };
    if (typeof inner.message === "string") {
      return inner.message;
    }
  }
  return null;
}

function isTransientRustHoverError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === -32801) {
    return true;
  }
  const message = hoverErrorMessage(error)?.toLowerCase();
  return !!message && message.includes("content modified");
}

function rustHoverTooltips(
  canRequest: () => boolean,
  config: { hoverTime?: number } = {},
): Extension {
  return hoverTooltip((view, pos): Promise<Tooltip | null> => {
    const plugin = LSPPlugin.get(view);
    if (!plugin || plugin.client.serverCapabilities?.hoverProvider === false || !canRequest()) {
      return Promise.resolve(null);
    }
    plugin.client.sync();
    return plugin.client
      .request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
      })
      .then((result) => {
        if (!result) {
          return null;
        }
        const contents = normalizeRustHover(result.contents);
        if (!contents) {
          return null;
        }
        return {
          pos: result.range ? plugin.fromPosition(result.range.start) : pos,
          end: result.range ? plugin.fromPosition(result.range.end) : pos,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
            dom.innerHTML = sanitizeHtml(plugin.docToHTML(contents));
            return { dom };
          },
        };
      })
      .catch((error: unknown) => {
        if (!canRequest() || isTransientRustHoverError(error)) {
          return null;
        }
        throw error;
      });
  }, config.hoverTime === undefined
    ? { hideOn: (transaction) => transaction.docChanged }
    : { hideOn: (transaction) => transaction.docChanged, hoverTime: config.hoverTime });
}

function rustClientExtensions(
  canRequestHover: () => boolean,
): readonly (Extension | LSPClientExtension)[] {
  return [
    serverCompletion(),
    rustHoverTooltips(canRequestHover),
    keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
    signatureHelp(),
  ];
}

function createRustInlineHandle(
  sessionApi: DemoSessionApi,
  options: EmbeddedBlockInlineCreateOptions<EmbeddedRustBlock>,
  initiallyEditing: boolean,
): EmbeddedBlockInlineHandle {
  const container = document.createElement("div");
  container.className = "cm-embedded-block-inline";
  const status = document.createElement("div");
  status.className = "cm-embedded-block-inline-status";
  status.textContent = "Connecting to rust-analyzer";
  const toggle = document.createElement("button");
  toggle.type = "button";
  const preview = document.createElement("div");
  const editorHost = document.createElement("div");
  const diagnosticSummary = document.createElement("ul");
  diagnosticSummary.className = "rosetta-diagnostics";
  diagnosticSummary.setAttribute("aria-label", "Rust diagnostics");
  let editing = initiallyEditing;
  editorHost.hidden = !editing;
  preview.hidden = editing;
  toggle.textContent = editing ? "Preview Rust" : "Edit Rust";
  container.append(toggle, status, preview, diagnosticSummary, editorHost);
  const binding = new Compartment();
  let previewEpoch = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 250;
  let connectPromise: Promise<void> | null = null;

  let destroyed = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticPullTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticPullEpoch = 0;
  let currentDocVersion = 1;
  let pendingDiagnosticsVersion: number | null = null;
  let resolvedDiagnosticsVersion = 0;
  let syncingFromOuter = false;
  let latestCode = options.block.code;
  let latestDiagnostics = [] as Array<{
    message: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
  }>;
  let lastDiagnosticStamp = "";
  let nestedView: EditorView | null = null;
  let socket: WebSocket | null = null;
  let client: LSPClient | null = null;
  let sessionInfo: { documentUri: string; key: string } | null = null;

  function canRequestHover(): boolean {
    return (
      !destroyed &&
      !syncingFromOuter &&
      client !== null
    );
  }

  function positionToOffset(
    doc: EditorState["doc"],
    position: { line: number; character: number },
  ): number {
    const line = doc.line(Math.max(1, Math.min(doc.lines, position.line + 1)));
    return Math.max(line.from, Math.min(line.to, line.from + position.character));
  }

  function severity(value?: number): Diagnostic["severity"] {
    return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : "hint";
  }

  function diagnosticsStamp(
    diagnostics: typeof latestDiagnostics,
  ): string {
    return JSON.stringify(
      diagnostics.map((diagnostic) => ({
        end: diagnostic.range.end,
        message: diagnostic.message,
        severity: diagnostic.severity,
        start: diagnostic.range.start,
      })),
    );
  }

  function applyDiagnostics(): void {
    if (!nestedView) {
      return;
    }
    nestedView.dispatch(
      setDiagnostics(
        nestedView.state,
        latestDiagnostics.map((diagnostic) => ({
          from: positionToOffset(nestedView!.state.doc, diagnostic.range.start),
          message: diagnostic.message,
          severity: severity(diagnostic.severity),
          to: positionToOffset(nestedView!.state.doc, diagnostic.range.end),
        })),
      ),
    );
    options.outerView.requestMeasure();
    diagnosticSummary.replaceChildren(...latestDiagnostics.map(diagnostic => {
      const item = document.createElement("li");
      item.textContent = diagnostic.message;
      item.dataset.severity = severity(diagnostic.severity);
      return item;
    }));
  }

  function updateDiagnosticsForVersion(
    version: number,
    diagnostics: typeof latestDiagnostics,
    optionsForUpdate: { log: boolean },
  ): void {
    if (version < resolvedDiagnosticsVersion) {
      return;
    }
    resolvedDiagnosticsVersion = version;
    const stamp = diagnosticsStamp(diagnostics);
    if (stamp === lastDiagnosticStamp) {
      return;
    }
    latestDiagnostics = diagnostics;
    lastDiagnosticStamp = stamp;
    applyDiagnostics();
    if (optionsForUpdate.log && diagnostics.length > 0) {
      options.log(`Rust diagnostics updated (${diagnostics.length})`);
    }
  }

  async function requestDiagnostics(
    session: { documentUri: string; key: string },
    epoch: number,
    expectedVersion: number,
    attempt = 0,
  ): Promise<void> {
    if (
      !client ||
      destroyed ||
      epoch !== diagnosticPullEpoch ||
      pendingDiagnosticsVersion !== expectedVersion
    ) {
      return;
    }
    client.sync();
    const report = await client.request<
      { textDocument: { uri: string } },
      { items?: typeof latestDiagnostics; kind: "full" | "unchanged" }
    >("textDocument/diagnostic", {
      textDocument: { uri: session.documentUri },
    });
    if (
      destroyed ||
      epoch !== diagnosticPullEpoch ||
      pendingDiagnosticsVersion !== expectedVersion ||
      report.kind !== "full"
    ) {
      return;
    }
    const pulled = Array.isArray(report.items) ? report.items : [];
    if (pulled.length > 0 || attempt >= 11) {
      pendingDiagnosticsVersion = null;
      updateDiagnosticsForVersion(expectedVersion, pulled, { log: true });
      return;
    }
    diagnosticPullTimer = setTimeout(() => {
      diagnosticPullTimer = null;
      void requestDiagnostics(session, epoch, expectedVersion, attempt + 1).catch(() => {});
    }, 500);
  }

  async function persistDocument(
    session: { documentUri: string; key: string },
    expectedVersion: number,
  ): Promise<void> {
    if (!client || destroyed) {
      return;
    }
    const activeClient = client;
    const code = latestCode;
    if (expectedVersion !== currentDocVersion) {
      return;
    }
    client.sync();
    if (destroyed) {
      return;
    }
    await sessionApi.updateRustDocument(session.key, code, expectedVersion);
    if (destroyed || expectedVersion !== currentDocVersion || client !== activeClient || sessionInfo?.key !== session.key) {
      return;
    }
    options.log(`Saved ${options.block.title}`);
    client.notification("textDocument/didSave", {
      text: code,
      textDocument: { uri: session.documentUri },
    });
    pendingDiagnosticsVersion = expectedVersion;
    if (diagnosticPullTimer) {
      clearTimeout(diagnosticPullTimer);
    }
    const epoch = ++diagnosticPullEpoch;
    diagnosticPullTimer = setTimeout(() => {
      diagnosticPullTimer = null;
      void requestDiagnostics(session, epoch, expectedVersion).catch(() => {});
    }, 900);
  }

  function schedulePersist(session: { documentUri: string; key: string }, expectedVersion: number): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistDocument(session, expectedVersion).catch((error) => {
        if (destroyed) {
          return;
        }
        options.log(
          error instanceof Error
            ? `Rust widget save failed: ${error.message}`
            : "Rust widget save failed.",
        );
      });
    }, 350);
  }

  async function refreshPreview(): Promise<void> {
    const epoch = ++previewEpoch;
    const source = latestCode;
    renderRustPreview(preview, source, [], async () => null);
    const activeClient = client;
    const activeSession = sessionInfo;
    if (!activeClient || !activeSession || !nestedView) return;
    activeClient.sync();
    try {
      let tokens: RustPreviewToken[] = [];
      // Semantic tokens may be empty while Cargo is loading the new crate.
      for (let attempt = 0; attempt < 12; attempt++) {
        if (destroyed || epoch !== previewEpoch || source !== latestCode || client !== activeClient) return;
        tokens = await activeClient.request<{ textDocument: { uri: string } }, RustPreviewToken[]>(
          "rosetta/preview", { textDocument: { uri: activeSession.documentUri } },
        );
        if (tokens.length || !source.trim()) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (destroyed || epoch !== previewEpoch || source !== latestCode || client !== activeClient) return;
      renderRustPreview(preview, source, tokens, async position => {
        if (source !== latestCode || activeClient !== client) return null;
        try {
          const result = await activeClient.request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
            position, textDocument: { uri: activeSession.documentUri },
          });
          return result ? normalizeRustHover(result.contents)?.value ?? null : null;
        } catch { return null; }
      });
    } catch (error) {
      if (!destroyed && epoch === previewEpoch) options.log(`Rust preview analysis pending: ${String(error)}`);
    }
    options.outerView.requestMeasure();
  }

  nestedView = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: latestCode,
      extensions: [
        ...baseRustAdapter.editorExtensions(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        binding.of([]),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || syncingFromOuter) return;
          currentDocVersion++;
          latestCode = update.state.doc.toString();
          options.syncOuter(latestCode);
          if (sessionInfo) schedulePersist(sessionInfo, currentDocVersion);
        }),
      ],
    }),
  });
  renderRustPreview(preview, latestCode, [], async () => null);
  toggle.addEventListener("click", () => {
    if (!client) void connect();
    editing = !editing;
    editorHost.hidden = !editing;
    preview.hidden = editing;
    toggle.textContent = editing ? "Preview Rust" : "Edit Rust";
    if (editing) { nestedView?.requestMeasure(); nestedView?.focus(); }
    else void refreshPreview();
    options.outerView.requestMeasure();
  });

  function connect(): Promise<void> {
    if (connectPromise || destroyed) return connectPromise ?? Promise.resolve();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectPromise = (async () => {
      diagnosticPullEpoch++;
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      if (diagnosticPullTimer) { clearTimeout(diagnosticPullTimer); diagnosticPullTimer = null; }
      const previousClient = client;
      const previousSocket = socket;
      client = null;
      socket = null;
      sessionInfo = null;
      // Reset running completion contexts before removing their state field.
      if (nestedView) nestedView.dispatch({ selection: nestedView.state.selection });
      nestedView?.dispatch({ effects: binding.reconfigure([]) });
      previousClient?.disconnect();
      previousSocket?.close();
      status.hidden = false;
      status.textContent = "Connecting through Rosetta";
      try {
        const session = await sessionApi.createRustSession(options.block.key, latestCode);
        if (destroyed) return;
        const nextClient: LSPClient = new LSPClient({
          extensions: rustClientExtensions(canRequestHover),
          notificationHandlers: {
            "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
              const file = nextClient.workspace.getFile(session.documentUri);
              if (destroyed || client !== nextClient || !file || params.uri !== session.documentUri ||
                  params.version !== file.version || file.doc.toString() !== latestCode) return true;
              pendingDiagnosticsVersion = null;
              diagnosticPullEpoch++;
              if (diagnosticPullTimer) clearTimeout(diagnosticPullTimer);
              updateDiagnosticsForVersion(currentDocVersion, [...params.diagnostics], { log: true });
              return true;
            },
          },
          rootUri: session.rootUri, sanitizeHTML: sanitizeHtml, timeout: 20_000,
        });
        const nextSocket = await sessionApi.connectWebSocket(session.websocketUrl);
        if (destroyed) { nextSocket.close(); return; }
        client = nextClient;
        socket = nextSocket;
        let timeout: ReturnType<typeof setTimeout>;
        const closed = new Promise<never>((_resolve, reject) => {
          nextSocket.addEventListener("close", () => reject(new Error("Rosetta connection closed")), { once: true });
          nextSocket.addEventListener("error", () => reject(new Error("Rosetta connection failed")), { once: true });
          timeout = setTimeout(() => reject(new Error("Rosetta initialization timed out")), 20_000);
        });
        try {
          nextClient.connect(createWebSocketTransport(nextSocket));
          await Promise.race([nextClient.initializing, closed]);
        } finally { clearTimeout(timeout!); }
        if (destroyed) { nextClient.disconnect(); nextSocket.close(); return; }
        sessionInfo = session;
        currentDocVersion = 1;
        resolvedDiagnosticsVersion = 0;
        pendingDiagnosticsVersion = null;
        diagnosticPullEpoch++;
        nestedView?.dispatch({ effects: binding.reconfigure(nextClient.plugin(session.documentUri, "rust")) });
        const interrupted = () => {
          if (!destroyed && socket === nextSocket) {
            status.hidden = false;
            status.textContent = "Reconnecting Rust through Rosetta";
            scheduleReconnect();
          }
        };
        nextSocket.addEventListener("close", interrupted, { once: true });
        nextSocket.addEventListener("error", interrupted, { once: true });
        status.hidden = true;
        reconnectDelay = 250;
        options.log("Rosetta Rust session ready.");
        schedulePersist(session, currentDocVersion);
        if (!editing) void refreshPreview();
      } catch (error) {
        if (destroyed) return;
        client?.disconnect();
        socket?.close();
        client = null;
        socket = null;
        sessionInfo = null;
        status.textContent = `Rosetta connection failed: ${String(error)}`;
        options.log(status.textContent);
        scheduleReconnect();
      }
    })().finally(() => { connectPromise = null; });
    return connectPromise;
  }
  function scheduleReconnect(): void {
    if (destroyed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay * 2);
  }
  void connect();

  return {
    destroy() {
      destroyed = true;
      previewEpoch++;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      if (diagnosticPullTimer) {
        clearTimeout(diagnosticPullTimer);
      }
      nestedView?.destroy();
      client?.disconnect();
      socket?.close();
    },
    dom: container,
    sync(code: string) {
      latestCode = code;
      if (!nestedView || nestedView.state.doc.toString() === code) {
        return;
      }
      syncingFromOuter = true;
      try {
        nestedView.dispatch({
          changes: {
            from: 0,
            insert: code,
            to: nestedView.state.doc.length,
          },
        });
      } finally {
        syncingFromOuter = false;
      }
      if (sessionInfo) {
        currentDocVersion += 1;
        schedulePersist(sessionInfo, currentDocVersion);
      }
      if (!editing) void refreshPreview();
      options.outerView.requestMeasure();
    },
  };
}

export function createEmbeddedRustAdapter(
  sessionApi: DemoSessionApi,
  initiallyEditing = false,
) {
  return {
    ...baseRustAdapter,
    createInlineHandle(options: EmbeddedBlockInlineCreateOptions<EmbeddedRustBlock>) {
      return createRustInlineHandle(sessionApi, options, initiallyEditing);
    },
  };
}

export const parseEmbeddedRustBlocks = baseRustAdapter.parseBlocks;
export const serializeEmbeddedRustBlock = baseRustAdapter.serializeBlock;
