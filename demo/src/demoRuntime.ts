import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { LSPClient, LSPPlugin, languageServerExtensions } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";
import { EditorServiceRuntime, type EditorDiagnostic, type EditorServiceDescriptor } from "@leanprover/editor-platform";

import {
  createLeanLspClient,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanUtilities,
  type LeanWorkspace,
} from "../../src/index.js";
import { createDemoBridge } from "./demoBridge.js";
import type { DemoSession, DemoSessionApi } from "./demoSession.js";
import type { DemoUi } from "./demoUi.js";
import { buildEmbeddedLeanDocument, type EmbeddedLeanDocument } from "./embeddedLean.js";
import { createEmbeddedEditorShell } from "./embeddedEditorShell.js";
import type { AnyEmbeddedBlockEditorAdapter, EmbeddedBlockDiagnostic } from "./embeddedBlocks.js";

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

export async function bootDemoRuntime(options: DemoRuntimeOptions): Promise<DemoRuntime> {
  let currentView: EditorView | null = null;
  let currentLanguageId: string | null = null;
  let currentUri: string | null = null;
  let workspace: LeanWorkspace | null = null;
  let client: ReturnType<typeof createLeanLspClient> | null = null;
  let rustClient: LSPClient | null = null;
  let socket: WebSocket | null = null;
  let rustSocket: WebSocket | null = null;
  let disposed = false;
  let embeddedLeanDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainRevision = 0;
  let rustMainQueue = Promise.resolve();
  let lastEmbeddedLeanDocument: EmbeddedLeanDocument | null = null;
  let lastRustMainSourceSent: string | null = null;
  const leanRuntime = new EditorServiceRuntime(options.ui.platformStore, leanService);
  const rustRuntime = new EditorServiceRuntime(options.ui.platformStore, rustService);

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
    const byBlock = new Map<string, EmbeddedBlockDiagnostic[]>();
    for (const diagnostic of params.diagnostics) {
      const start = lastEmbeddedLeanDocument.mappings.find(
        (mapping) => mapping.generatedLine === diagnostic.range.start.line,
      );
      if (!start) {
        continue;
      }
      const end =
        lastEmbeddedLeanDocument.mappings.find(
          (mapping) => mapping.generatedLine === diagnostic.range.end.line && mapping.blockKey === start.blockKey,
        ) ?? start;
      const mapped = byBlock.get(start.blockKey) ?? [];
      mapped.push({
        from: start.blockLineStart + diagnostic.range.start.character,
        message: diagnostic.message,
        severity: diagnosticSeverity(diagnostic.severity),
        to: Math.max(
          start.blockLineStart + diagnostic.range.start.character,
          end.blockLineStart + diagnostic.range.end.character,
        ),
      });
      byBlock.set(start.blockKey, mapped);
    }
    embeddedEditors.setDiagnostics("lean", byBlock);
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

    const view = new EditorView({
      parent: options.ui.editorHost,
      state: EditorState.create({
        doc,
        extensions: [
          ...languageExtensions,
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

  options.ui.setStatus("Loading session");
  const session = await options.sessionApi.fetchSession();
  options.ui.setRootUri(session.rootUri);
  options.ui.setCurrentDocument(session.documentUri);

  options.ui.setStatus("Connecting to Lean");
  leanRuntime.starting("Connecting");
  socket = await options.sessionApi.connectWebSocket(session.websocketUrl);
  leanRuntime.starting("Initializing");
  client = createLeanLspClient({
    notificationHandlers: {
      "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
        applyEmbeddedLeanDiagnostics(params);
        return false;
      },
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
  client.connect(createWebSocketTransport(socket));
  await client.initializing;
  leanRuntime.ready();
  workspace = client.workspace as LeanWorkspace;
  if (session.embeddedLeanDocumentUri) {
    await workspace.openServerDocument(session.embeddedLeanDocumentUri);
  }

  if (session.rustMainWebsocketUrl) {
    rustRuntime.starting("Connecting");
    rustSocket = await options.sessionApi.connectWebSocket(session.rustMainWebsocketUrl);
    rustRuntime.starting("Initializing");
    rustClient = new LSPClient({
      extensions: languageServerExtensions(),
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) =>
          applyRustMainDiagnostics(params),
      },
      rootUri: session.rootUri,
    });
    rustClient.connect(createWebSocketTransport(rustSocket));
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

  const handleSocketClose = () => {
    if (disposed) {
      return;
    }
    options.ui.setStatus("Reconnecting");
    leanRuntime.stale("Reconnecting");
    options.ui.logEvent("Lean server connection closed. Waiting for restart.");
    options.requestRestart("Lean server connection closed.");
  };
  const handleSocketError = () => {
    if (disposed) {
      return;
    }
    options.ui.setStatus("Reconnecting");
    leanRuntime.stale("Reconnecting");
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
      client?.disconnect();
      leanRuntime.stopped();
      socket?.close();
      rustClient?.disconnect();
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
