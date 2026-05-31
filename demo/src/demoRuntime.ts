import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { LSPClient, LSPPlugin, languageServerExtensions } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";
import { EditorServiceRuntime, type EditorDiagnostic, type EditorServiceDescriptor } from "@leanprover/editor-platform";
import { Marked } from "marked";

import {
  createLeanLspClient,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanFileProgress,
  leanUtilities,
  type Transport,
  type LeanWorkspace,
} from "../../src/index.js";
import { workDoneProgress, type WorkDoneProgressState } from "../../src/progress.js";
import { createDemoBridge } from "./demoBridge.js";
import type { DemoPreparationStatus, DemoSession, DemoSessionApi } from "./demoSession.js";
import type { DemoUi } from "./demoUi.js";
import {
  buildEmbeddedLeanDocument,
  mapEmbeddedLeanDiagnostics,
  type EmbeddedLeanDocument,
} from "./embeddedLean.js";
import { createEmbeddedEditorShell, type ActiveEmbeddedEditor } from "./embeddedEditorShell.js";
import type { AnyEmbeddedBlockEditorAdapter, EmbeddedBlockDiagnostic } from "./embeddedBlocks.js";
import {
  createLeanInfoviewHost,
  forwardLeanClientNotifications,
  type LeanInfoviewHost,
} from "./leanInfoview.js";

const leanService: EditorServiceDescriptor = {
  id: "lean-lsp",
  kind: "lean-lsp",
  label: "Lean",
};

const rustService: EditorServiceDescriptor = {
  id: "rust-lsp",
  kind: "rust-lsp",
  label: "Rust",
};

const leanHoverMarkdown = new Marked();
const preparationPollDelayMs = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>\n]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "<br>";
    }
  });
}

export interface DemoRuntimeOptions {
  editorTheme: Extension;
  embeddedAdapters: readonly AnyEmbeddedBlockEditorAdapter[];
  requestRestart(reason: string): void;
  sessionApi: DemoSessionApi;
  ui: DemoUi;
}

export interface DemoRuntime {
  dispose(): void;
}

function observeInitializeResult(
  transport: Transport,
  onInitializeResult: (result: lsp.InitializeResult) => void,
): Transport {
  const handlers = new Map<(message: string) => void, (message: string) => void>();
  return {
    send(message) {
      transport.send(message);
    },
    subscribe(handler) {
      const wrapped = (message: string) => {
        try {
          const payload = JSON.parse(message) as Partial<lsp.ResponseMessage>;
          if (
            payload &&
            "result" in payload &&
            payload.result &&
            typeof payload.result === "object" &&
            "capabilities" in payload.result
          ) {
            onInitializeResult(payload.result as lsp.InitializeResult);
          }
        } catch {
          // The underlying LSP client will report malformed messages.
        }
        handler(message);
      };
      handlers.set(handler, wrapped);
      transport.subscribe(wrapped);
    },
    unsubscribe(handler) {
      const wrapped = handlers.get(handler);
      if (!wrapped) {
        return;
      }
      handlers.delete(handler);
      transport.unsubscribe(wrapped);
    },
  };
}

function workDoneProgressMessage(state: WorkDoneProgressState): string {
  const percentage = typeof state.percentage === "number" ? ` ${state.percentage}%` : "";
  return state.message ? `${state.title}${percentage}: ${state.message}` : `${state.title}${percentage}`;
}

export async function bootDemoRuntime(options: DemoRuntimeOptions): Promise<DemoRuntime> {
  let currentView: EditorView | null = null;
  let currentLanguageId: string | null = null;
  let currentUri: string | null = null;
  let workspace: LeanWorkspace | null = null;
  let client: ReturnType<typeof createLeanLspClient> | null = null;
  let leanInfoview: LeanInfoviewHost | null = null;
  let rustClient: LSPClient | null = null;
  let socket: WebSocket | null = null;
  let rustSocket: WebSocket | null = null;
  let restoreLeanNotificationForwarding: (() => void) | null = null;
  let disposed = false;
  let embeddedLeanDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainRevision = 0;
  let rustMainQueue = Promise.resolve();
  let lastEmbeddedLeanDocument: EmbeddedLeanDocument | null = null;
  let lastRustMainSourceSent: string | null = null;
  let leanInitializeResult: lsp.InitializeResult | null = null;
  const leanRuntime = new EditorServiceRuntime(options.ui.platformStore, leanService);
  const rustRuntime = new EditorServiceRuntime(options.ui.platformStore, rustService);
  const leanProgress = leanFileProgress({
    onUpdate(update) {
      if (update.uri !== currentUri) {
        return;
      }
      if (!update.state) {
        leanRuntime.recordConnectionStatus({ phase: "ready", message: "Ready" });
        return;
      }
      leanRuntime.recordConnectionStatus({
        phase: "ready",
        message: update.state.hasFatalError ? "Fatal Lean processing error" : "Processing Lean file",
      });
    },
  });
  const rustProgress = workDoneProgress({
    onUpdate(update) {
      if (update.kind === "end") {
        const active = rustProgress.store.entries().at(-1);
        rustRuntime.recordConnectionStatus({
          phase: "ready",
          message: active ? workDoneProgressMessage(active) : "Ready",
        });
        return;
      }
      if (!update.state) {
        return;
      }
      rustRuntime.recordConnectionStatus({
        phase: "ready",
        message: workDoneProgressMessage(update.state),
      });
    },
  });

  const embeddedEditors = createEmbeddedEditorShell({
    currentLanguageId() {
      return currentLanguageId;
    },
    currentUri() {
      return currentUri;
    },
    currentView() {
      return currentView;
    },
    extraExtensions(adapter, block) {
      return adapter.kind === "lean" ? [embeddedLeanHoverTooltips(block.key)] : [];
    },
    setActiveEmbeddedEditor(editor) {
      setActiveEmbeddedEditor(editor);
    },
    log(message) {
      options.ui.logEvent(message);
    },
  });

  const embeddedBlockExtensions = embeddedEditors.extensionsFor(options.embeddedAdapters);
  const demoBridge = createDemoBridge({
    currentUri() {
      return currentUri;
    },
    currentView() {
      return currentView;
    },
    redo() {
      return currentView ? redo(currentView) : false;
    },
    undo() {
      return currentView ? undo(currentView) : false;
    },
  });

  function languageIdForUri(session: DemoSession, uri: string): string {
    return session.documentLanguageIds?.[uri] ?? (uri.endsWith(".rs") ? "rust" : "lean4");
  }

  function refreshLeanWorkspaceArtifacts(result: {
    leanDocumentUri: string;
  }, leanDocument: string): void {
    const leanFile = workspace?.getFile(result.leanDocumentUri);
    if (leanFile) {
      workspace?.updateFile(result.leanDocumentUri, {
        changes: {
          from: 0,
          insert: leanDocument,
          to: leanFile.doc.length,
        },
      });
      client?.sync();
      scheduleEmbeddedLeanDiagnosticPull(result.leanDocumentUri);
    }
    client?.notification("workspace/didChangeWatchedFiles", {
      changes: [
        { type: 2, uri: result.leanDocumentUri },
      ],
    });
  }

  function diagnosticSeverity(value?: lsp.DiagnosticSeverity): NonNullable<EmbeddedBlockDiagnostic["severity"]> {
    return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : "hint";
  }

  function editorDiagnosticsFromLsp(
    uri: string,
    source: string,
    diagnostics: readonly lsp.Diagnostic[],
  ): EditorDiagnostic[] {
    return diagnostics.map((diagnostic) => ({
      uri,
      source,
      message: diagnostic.message,
      severity: diagnosticSeverity(diagnostic.severity),
      ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    }));
  }

  function applyRustMainDiagnostics(params: lsp.PublishDiagnosticsParams): boolean {
    if (params.uri === session.rustMainDocumentUri) {
      options.ui.setDocumentDiagnostics(
        params.uri,
        editorDiagnosticsFromLsp(params.uri, "rust-analyzer", params.diagnostics),
      );
    }
    if (params.uri !== session.rustMainDocumentUri || currentUri !== params.uri || !currentView) {
      return false;
    }
    const plugin = LSPPlugin.get(currentView);
    if (!plugin) {
      return false;
    }
    currentView.dispatch(
      setDiagnostics(
        currentView.state,
        params.diagnostics.map((diagnostic) => ({
          from: Math.max(
            0,
            Math.min(currentView!.state.doc.length, plugin.fromPosition(diagnostic.range.start)),
          ),
          message: diagnostic.message,
          severity: diagnosticSeverity(diagnostic.severity),
          to: Math.max(
            0,
            Math.min(currentView!.state.doc.length, plugin.fromPosition(diagnostic.range.end)),
          ),
        })),
      ),
    );
    return true;
  }

  function applyEmbeddedLeanDiagnostics(params: lsp.PublishDiagnosticsParams): void {
    if (params.uri !== session.embeddedLeanDocumentUri || !lastEmbeddedLeanDocument) {
      return;
    }
    options.ui.setDocumentDiagnostics(
      params.uri,
      editorDiagnosticsFromLsp(params.uri, "lean", params.diagnostics),
    );
    const byBlock = mapEmbeddedLeanDiagnostics(
      lastEmbeddedLeanDocument,
      params.diagnostics.map((diagnostic) => ({
        message: diagnostic.message,
        range: diagnostic.range,
        severity: diagnosticSeverity(diagnostic.severity),
      })),
    );
    embeddedEditors.setDiagnostics("lean", byBlock);
  }

  function embeddedLeanPosition(blockKey: string, view: EditorView, offset: number): lsp.Position | null {
    if (!lastEmbeddedLeanDocument) {
      return null;
    }
    const clamped = Math.max(0, Math.min(view.state.doc.length, offset));
    const line = view.state.doc.lineAt(clamped);
    const blockMappings = lastEmbeddedLeanDocument.mappings.filter((mapping) => mapping.blockKey === blockKey);
    const mapping = blockMappings.find((candidate) => candidate.blockLineStart === line.from)
      ?? blockMappings[line.number - 1];
    if (!mapping) {
      return null;
    }
    return {
      character: Math.max(0, clamped - line.from),
      line: mapping.generatedLine,
    };
  }

  function embeddedLeanOffset(blockKey: string, view: EditorView, position: lsp.Position): number | null {
    if (!lastEmbeddedLeanDocument) {
      return null;
    }
    const mapping = lastEmbeddedLeanDocument.mappings.find(
      (candidate) => candidate.blockKey === blockKey && candidate.generatedLine === position.line,
    );
    if (!mapping) {
      return null;
    }
    return Math.max(
      0,
      Math.min(view.state.doc.length, mapping.blockLineStart + position.character),
    );
  }

  function renderLeanHoverMarkdown(value: string): string {
    const html = leanHoverMarkdown.parse(value, { async: false });
    return typeof html === "string" ? html : "";
  }

  function leanHoverHtml(
    contents: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
  ): string {
    if (Array.isArray(contents)) {
      return contents.map((item) => leanHoverHtml(item)).filter(Boolean).join("<br>");
    }
    if (typeof contents === "string") {
      return renderLeanHoverMarkdown(contents);
    }
    if ("language" in contents) {
      return renderLeanHoverMarkdown(`\`\`\`${contents.language}\n${contents.value}\n\`\`\``);
    }
    return contents.kind === "markdown" ? renderLeanHoverMarkdown(contents.value) : escapeHtml(contents.value);
  }

  function embeddedLeanHoverTooltips(blockKey: string): Extension {
    return hoverTooltip((view, pos): Promise<Tooltip | null> => {
      if (
        !client ||
        !session.embeddedLeanDocumentUri ||
        client.serverCapabilities?.hoverProvider === false
      ) {
        return Promise.resolve(null);
      }
      const position = embeddedLeanPosition(blockKey, view, pos);
      if (!position) {
        return Promise.resolve(null);
      }
      client.sync();
      return client
        .request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
          position,
          textDocument: { uri: session.embeddedLeanDocumentUri },
        })
        .then((result) => {
          if (!result) {
            return null;
          }
          const html = leanHoverHtml(result.contents).trim();
          if (!html) {
            return null;
          }
          const start = result.range
            ? embeddedLeanOffset(blockKey, view, result.range.start) ?? pos
            : pos;
          const end = result.range
            ? embeddedLeanOffset(blockKey, view, result.range.end) ?? pos
            : pos;
          return {
            above: true,
            end,
            pos: start,
            create() {
              const dom = document.createElement("div");
              dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
              dom.innerHTML = html;
              return { dom };
            },
          };
        })
        .catch(() => null);
    }, { hideOn: (transaction) => transaction.docChanged });
  }

  function embeddedLeanLocation(editor: ActiveEmbeddedEditor): lsp.Location | undefined {
    if (editor.adapter.kind !== "lean" || !session.embeddedLeanDocumentUri) {
      return undefined;
    }
    const selection = editor.view.state.selection.main;
    const start = embeddedLeanPosition(editor.block.key, editor.view, selection.from);
    const end = embeddedLeanPosition(editor.block.key, editor.view, selection.to);
    if (!start || !end) {
      return undefined;
    }
    return {
      range: { end, start },
      uri: session.embeddedLeanDocumentUri,
    };
  }

  function setActiveEmbeddedEditor(editor: ActiveEmbeddedEditor | null): void {
    if (!leanInfoview) {
      return;
    }
    if (!editor) {
      leanInfoview.updateCursorLocation();
      return;
    }
    leanInfoview.setCursorLocation(embeddedLeanLocation(editor));
  }

  function scheduleEmbeddedLeanDiagnosticPull(uri: string, attempt = 0): void {
    if (!client || disposed) {
      return;
    }
    if (embeddedLeanDiagnosticTimer) {
      clearTimeout(embeddedLeanDiagnosticTimer);
    }
    embeddedLeanDiagnosticTimer = setTimeout(() => {
      embeddedLeanDiagnosticTimer = null;
      const request = leanRuntime.beginRequest("textDocument/diagnostic");
      void client
        ?.request<
          { textDocument: { uri: string } },
          { items?: lsp.Diagnostic[]; kind: "full" | "unchanged" }
        >("textDocument/diagnostic", {
          textDocument: { uri },
        })
        .then((report) => {
          request.succeeded();
          if (disposed || report.kind !== "full") {
            return;
          }
          applyEmbeddedLeanDiagnostics({
            diagnostics: Array.isArray(report.items) ? report.items : [],
            uri,
          });
          if ((!report.items || report.items.length === 0) && attempt < 3) {
            scheduleEmbeddedLeanDiagnosticPull(uri, attempt + 1);
          }
        })
        .catch((error) => {
          request.failed(error);
        });
    }, attempt === 0 ? 350 : 500);
  }

  function scheduleRustMainDiagnosticPull(uri: string, attempt = 0): void {
    if (!rustClient || disposed) {
      return;
    }
    if (rustMainDiagnosticTimer) {
      clearTimeout(rustMainDiagnosticTimer);
    }
    rustMainDiagnosticTimer = setTimeout(() => {
      rustMainDiagnosticTimer = null;
      const request = rustRuntime.beginRequest("textDocument/diagnostic");
      void rustClient
        ?.request<
          { textDocument: { uri: string } },
          { items?: lsp.Diagnostic[]; kind: "full" | "unchanged" }
        >("textDocument/diagnostic", {
          textDocument: { uri },
        })
        .then((report) => {
          request.succeeded();
          if (disposed || report.kind !== "full") {
            return;
          }
          applyRustMainDiagnostics({
            diagnostics: Array.isArray(report.items) ? report.items : [],
            uri,
          });
          if ((!report.items || report.items.length === 0) && attempt < 4) {
            scheduleRustMainDiagnosticPull(uri, attempt + 1);
          }
        })
        .catch((error) => {
          request.failed(error);
        });
    }, attempt === 0 ? 650 : 700);
  }

  function scheduleRustMainSync(): void {
    if (!rustClient || disposed) {
      return;
    }
    if (rustMainSyncTimer) {
      clearTimeout(rustMainSyncTimer);
    }
    rustMainSyncTimer = setTimeout(() => {
      rustMainSyncTimer = null;
      rustClient?.sync();
      if (session.rustMainDocumentUri) {
        scheduleRustMainDiagnosticPull(session.rustMainDocumentUri);
      }
    }, 150);
  }

  function clearRustMainDiagnostics(): void {
    if (currentUri !== session.rustMainDocumentUri || !currentView) {
      return;
    }
    currentView.dispatch(setDiagnostics(currentView.state, []));
  }

  function scheduleRustMainPersist(session: DemoSession, uri: string, source: string): void {
    if (uri !== session.rustMainDocumentUri) {
      return;
    }
    if (source === lastRustMainSourceSent) {
      return;
    }
    if (rustMainPersistTimer) {
      clearTimeout(rustMainPersistTimer);
    }
    rustMainPersistTimer = setTimeout(() => {
      rustMainPersistTimer = null;
      const revision = ++rustMainRevision;
      const embeddedLeanDocument = buildEmbeddedLeanDocument(source, {
        sourceName: uri.split("/").at(-1) ?? "Main.rs",
      });
      const leanDocument = embeddedLeanDocument.doc;
      rustMainQueue = rustMainQueue
        .then(async () => {
          if (disposed || revision !== rustMainRevision) {
            return;
          }
          const request = rustRuntime.beginRequest("rust-main/update");
          const result = await options.sessionApi.updateRustMainDocument({
            code: source,
            leanDocument,
            revision,
            uri,
          }).then(
            (value) => {
              request.succeeded();
              return value;
            },
            (error) => {
              request.failed(error);
              throw error;
            },
          );
          if (disposed || result.stale || revision !== rustMainRevision) {
            return;
          }
          lastRustMainSourceSent = source;
          lastEmbeddedLeanDocument = embeddedLeanDocument;
          refreshLeanWorkspaceArtifacts(result, leanDocument);
          options.ui.setDocumentSyncState(uri, "clean");
          options.ui.logEvent("Rust driver saved; Lean snippets refreshed.");
        })
        .catch((error) => {
          if (disposed) {
            return;
          }
          options.ui.logEvent(
            error instanceof Error ? `Rust driver update failed: ${error.message}` : "Rust driver update failed.",
          );
          options.ui.setDocumentSyncState(
            uri,
            "failed",
            error instanceof Error ? error.message : "Rust driver update failed.",
          );
        });
    }, 450);
  }

  async function mountDocument(uri: string, doc: string): Promise<EditorView> {
    if (disposed) {
      throw new Error("Demo runtime is disposed.");
    }
    const languageId = languageIdForUri(session, uri);
    client?.sync();
    currentView?.destroy();
    embeddedEditors.close();
    options.ui.editorHost.replaceChildren();
    currentUri = uri;
    currentLanguageId = languageId;

    const languageExtensions: Extension[] =
      languageId === "rust"
        ? [
            rust(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            ...leanUtilities({
              lineWrapping: true,
            }),
            ...(rustClient && uri === session.rustMainDocumentUri
              ? [rustClient.plugin(uri, "rust")]
              : []),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                options.ui.setDocumentSyncState(uri, "dirty");
                clearRustMainDiagnostics();
                scheduleRustMainSync();
                scheduleRustMainPersist(session, uri, update.state.doc.toString());
              }
            }),
          ]
        : lean4({
            client,
            uri,
            utilities: {
              lineWrapping: true,
            },
          });
    const infoviewExtensions: Extension[] = [leanInfoview?.editorExtension()].filter(
      (ext): ext is Extension => !!ext,
    );

    const view = new EditorView({
      parent: options.ui.editorHost,
      state: EditorState.create({
        doc,
        extensions: [
          ...languageExtensions,
          ...infoviewExtensions,
          options.editorTheme,
          ...embeddedBlockExtensions,
        ],
      }),
    });
    currentView = view;
    options.ui.setCurrentDocument(uri, languageId);
    options.ui.setActiveDocument(uri);
    if (languageId === "rust") {
      scheduleRustMainPersist(session, uri, doc);
    }
    return view;
  }

  let lastPreparationMessage = "";

  function preparationStatusMessage(status: DemoPreparationStatus): string {
    return status.detail ? `${status.message} ${status.detail}` : status.message;
  }

  function logPreparationStatus(status: DemoPreparationStatus): void {
    const message = preparationStatusMessage(status);
    if (message !== lastPreparationMessage) {
      options.ui.logEvent(message);
      lastPreparationMessage = message;
    }
    if (status.phase === "idle" || status.phase === "preparing") {
      options.ui.setStatus(status.message);
    }
  }

  async function fetchSessionWithPreparationProgress(): Promise<DemoSession> {
    while (!disposed) {
      const status = await options.sessionApi.fetchPreparationStatus();
      logPreparationStatus(status);
      if (status.phase === "failed") {
        throw new Error(preparationStatusMessage(status));
      }
      if (status.phase === "ready") {
        break;
      }
      await delay(preparationPollDelayMs);
    }
    options.ui.setStatus("Loading session");
    const nextSession = await options.sessionApi.fetchSession();
    if (nextSession.preparationStatus) {
      logPreparationStatus(nextSession.preparationStatus);
    }
    return nextSession;
  }

  options.ui.setStatus("Loading session");
  const session = await fetchSessionWithPreparationProgress();
  options.ui.setRootUri(session.rootUri);
  options.ui.setCurrentDocument(session.documentUri);

  options.ui.setStatus("Connecting to Lean");
  leanRuntime.connecting();
  socket = await options.sessionApi.connectWebSocket(session.websocketUrl);
  leanRuntime.initializing();
  client = createLeanLspClient({
    extensions: [leanProgress],
    notificationHandlers: {
      "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
        leanInfoview?.forwardServerNotification("textDocument/publishDiagnostics", params);
        applyEmbeddedLeanDiagnostics(params);
        return false;
      },
    },
    unhandledNotification(_client, method, params) {
      leanInfoview?.forwardServerNotification(method, params);
    },
    rootUri: session.rootUri,
    workspace: createLeanWorkspace({
      async loadDocument(uri) {
        return {
          doc:
            uri === session.documentUri
              ? session.initialDoc
              : await options.sessionApi.fetchDocument(uri),
        };
      },
      async displayDocument(uri, currentWorkspace) {
        const file = await currentWorkspace.requestFile(uri);
        const doc = file?.doc.toString() ?? (await options.sessionApi.fetchDocument(uri));
        return mountDocument(uri, doc);
      },
    }),
  });
  client.connect(observeInitializeResult(createWebSocketTransport(socket), (result) => {
    leanInitializeResult = result;
  }));
  await client.initializing;
  leanRuntime.ready();
  workspace = client.workspace as LeanWorkspace;
  leanInfoview = createLeanInfoviewHost({
    client,
    container: options.ui.infoviewHost,
    currentLanguageId() {
      return currentLanguageId;
    },
    currentUri() {
      return currentUri;
    },
    currentView() {
      return currentView;
    },
    log(message) {
      options.ui.logEvent(message);
    },
    requestRestart(reason) {
      options.requestRestart(reason);
    },
    workspace() {
      return workspace;
    },
  });
  restoreLeanNotificationForwarding = forwardLeanClientNotifications(client, leanInfoview);
  leanInfoview.serverRestarted(leanInitializeResult ?? undefined);
  if (session.embeddedLeanDocumentUri) {
    await workspace.openServerDocument(session.embeddedLeanDocumentUri);
  }

  if (session.rustMainWebsocketUrl) {
    rustRuntime.connecting();
    rustSocket = await options.sessionApi.connectWebSocket(session.rustMainWebsocketUrl);
    rustRuntime.initializing();
    rustClient = new LSPClient({
      extensions: [rustProgress, ...languageServerExtensions()],
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) =>
          applyRustMainDiagnostics(params),
      },
      rootUri: session.rootUri,
    });
    rustClient.connect(rustProgress.wrapTransport(createWebSocketTransport(rustSocket)));
    await rustClient.initializing;
    rustRuntime.ready();
    options.ui.logEvent("rust-analyzer initialized.");
  } else {
    rustRuntime.stopped();
  }

  const openDocument = async (uri: string): Promise<void> => {
    const file = await workspace?.requestFile(uri);
    const doc = file?.doc.toString() ?? (await options.sessionApi.fetchDocument(uri));
    await mountDocument(uri, doc);
    options.ui.logEvent(`Opened ${uri.split("/").at(-1) ?? uri}`);
  };

  demoBridge.install(openDocument);
  options.ui.renderDocumentButtons(session.documents, openDocument);
  await mountDocument(session.documentUri, session.initialDoc);
  leanInfoview.updateCursorLocation();

  const handleSocketClose = () => {
    if (disposed) {
      return;
    }
    options.ui.setStatus("Reconnecting");
    leanRuntime.recordConnectionStatus({ phase: "stale", message: "Reconnecting" });
    options.ui.logEvent("Lean server connection closed. Waiting for restart.");
    options.requestRestart("Lean server connection closed.");
  };
  const handleSocketError = () => {
    if (disposed) {
      return;
    }
    options.ui.setStatus("Reconnecting");
    leanRuntime.recordConnectionStatus({ phase: "stale", message: "Reconnecting" });
    options.ui.logEvent("WebSocket transport interrupted. Retrying.");
    options.requestRestart("WebSocket transport interrupted.");
  };
  const handleBeforeUnload = () => {
    runtime.dispose();
  };

  socket.addEventListener("close", handleSocketClose);
  socket.addEventListener("error", handleSocketError);
  window.addEventListener("beforeunload", handleBeforeUnload);

  options.ui.setStatus("Ready");
  options.ui.logEvent("Lean server initialized.");

  const runtime: DemoRuntime = {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (rustMainPersistTimer) {
        clearTimeout(rustMainPersistTimer);
        rustMainPersistTimer = null;
      }
      if (rustMainSyncTimer) {
        clearTimeout(rustMainSyncTimer);
        rustMainSyncTimer = null;
      }
      if (rustMainDiagnosticTimer) {
        clearTimeout(rustMainDiagnosticTimer);
        rustMainDiagnosticTimer = null;
      }
      if (embeddedLeanDiagnosticTimer) {
        clearTimeout(embeddedLeanDiagnosticTimer);
        embeddedLeanDiagnosticTimer = null;
      }
      window.removeEventListener("beforeunload", handleBeforeUnload);
      socket?.removeEventListener("close", handleSocketClose);
      socket?.removeEventListener("error", handleSocketError);
      embeddedEditors.close();
      currentView?.destroy();
      currentView = null;
      demoBridge.clear();
      restoreLeanNotificationForwarding?.();
      restoreLeanNotificationForwarding = null;
      leanInfoview?.serverStopped({ message: "Lean server stopped.", reason: "Demo runtime disposed." });
      leanInfoview?.dispose();
      leanInfoview = null;
      client?.disconnect();
      leanProgress.clear();
      leanRuntime.stopped();
      socket?.close();
      rustClient?.disconnect();
      rustProgress.clear();
      rustRuntime.stopped();
      rustSocket?.close();
      socket = null;
      rustSocket = null;
      workspace = null;
      client = null;
      rustClient = null;
    },
  };

  return runtime;
}
