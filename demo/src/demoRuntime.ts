import { DemoDocuments, type AuthoredSnapshot } from "./demoDocuments.js";
import { SourcePersistence } from "./sourcePersistence.js";
import { ConnectionScope } from "./connectionScope.js";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { LSPClient, LSPPlugin, languageServerExtensions } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";
import { EditorServiceRuntime } from "@leanprover/editor-platform";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";

import {
  createLeanEditorSession,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanFileProgress,
  leanFallbackHighlightStyle,
  leanUtilities,
  type LeanEditorSession,
  type LeanServerDocumentLease,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import { workDoneProgress } from "../../src/progress.js";
import { createDemoBridge } from "./demoBridge.js";
import {
  DiagnosticGenerationGate,
  type DiagnosticGenerationTicket,
} from "./diagnosticGeneration.js";
import type { DemoExample, DemoPreparationStatus, DemoSession, DemoSessionApi, RustMainUpdateResult } from "./demoSession.js";
import type { DemoUi, RegenerationMode } from "./demoUi.js";
import {
  buildEmbeddedLeanDocument,
  embeddedLeanHostFingerprint,
  mapEmbeddedLeanDiagnostics,
  type EmbeddedLeanDocument,
} from "./embeddedLean.js";
import { createEmbeddedEditorShell, type ActiveEmbeddedEditor } from "./embeddedEditorShell.js";
import { filterLeanHovers, rustPositionAt } from "./rustSourceHover.js";
import type { AnyEmbeddedBlockEditorAdapter } from "./embeddedBlocks.js";
import {
  createEmbeddedLeanLspFeatures,
  diagnosticSeverity,
  editorDiagnosticsFromLsp,
} from "./embeddedLeanLsp.js";
import { sanitizeHtml } from "./sanitizeHtml.js";
import {
  delay,
  leanService,
  loadRegenerationMode,
  observeInitializeResult,
  rustService,
  saveRegenerationMode,
  workDoneProgressMessage,
} from "./runtimeSupport.js";

const autoRegenerationDelayMs = 1400;
const preparationPollDelayMs = 500;

export interface DemoRuntimeOptions {
  editorTheme: Extension;
  embeddedAdapters: readonly AnyEmbeddedBlockEditorAdapter[];
  requestRestart(reason: string): void;
  sessionApi: DemoSessionApi;
  switchExample(example: DemoExample): Promise<void>;
  ui: DemoUi;
}

export interface DemoRuntime {
  dispose(): void;
}

export async function bootDemoRuntime(options: DemoRuntimeOptions): Promise<DemoRuntime> {
  const rustBinding = new Compartment();
  let currentView: EditorView | null = null;
  let currentLanguageId: string | null = null;
  let currentUri: string | null = null;
  const documents = new DemoDocuments(() => currentView && currentUri
    ? { uri: currentUri, state: currentView.state } : null);
  let persistence: SourcePersistence<RustMainUpdateResult> | null = null;
  let activationRevision = 0;
  let workspace: LeanWorkspace | null = null;
  let client: LSPClient | null = null;
  let leanSessionOwner: LeanEditorSession | null = null;
  let embeddedLeanServerLease: LeanServerDocumentLease | null = null;
  let leanInfoview: LeanInfoviewHost | null = null;
  let rustClient: LSPClient | null = null;
  let socket: WebSocket | null = null;
  let rustSocket: WebSocket | null = null;
  let detachLeanSocketListeners: (() => void) | null = null;
  let leanReconnectPromise: Promise<void> | null = null;
  let rustReconnectPromise: Promise<void> | null = null;
  let disposed = false;
  let embeddedLeanDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainPushTicket: DiagnosticGenerationTicket | null = null;
  let rustMainSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainAutoRegenerateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmbeddedLeanDocument: EmbeddedLeanDocument | null = null;
  let lastRustMainSourceSent: string | null = null;
  let leanInitializeResult: lsp.InitializeResult | null = null;
  let rustMainBaselineFingerprint: string | null = null;
  let rustMainExtractionFresh: boolean | null = null;
  let rustMainRegenerationInFlight = false;
  let regenerationMode = loadRegenerationMode();
  let suppressedAutoRegenerationSource: string | null = null;
  const leanRuntime = new EditorServiceRuntime(options.ui.platformStore, leanService);
  const rustRuntime = new EditorServiceRuntime(options.ui.platformStore, rustService);
  const embeddedLeanDiagnosticGate = new DiagnosticGenerationGate();
  const rustMainDiagnosticGate = new DiagnosticGenerationGate();
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

  const embeddedLeanLsp = createEmbeddedLeanLspFeatures({
    client() {
      return client;
    },
    document() {
      return lastEmbeddedLeanDocument;
    },
    documentUri() {
      return session.embeddedLeanDocumentUri;
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
      return adapter.kind === "lean" ? [embeddedLeanLsp.hoverTooltips(block.key)] : [];
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
    restartLean() {
      return reconnectLean("Demo bridge requested a Lean restart.");
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
      embeddedLeanDiagnosticGate.beginEdit();
      workspace?.updateFile(result.leanDocumentUri, {
        changes: {
          from: 0,
          insert: leanDocument,
          to: leanFile.doc.length,
        },
      });
      client?.sync();
      client?.notification("textDocument/didSave", {
        text: leanDocument,
        textDocument: { uri: result.leanDocumentUri },
      });
      const ticket = embeddedLeanDiagnosticGate.recordSync(leanFile.version);
      scheduleEmbeddedLeanDiagnosticPull(result.leanDocumentUri, ticket);
    }
    client?.notification("workspace/didChangeWatchedFiles", {
      changes: [
        { type: 2, uri: result.leanDocumentUri },
      ],
    });
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

  function setActiveEmbeddedEditor(editor: ActiveEmbeddedEditor | null): void {
    if (!leanInfoview) {
      return;
    }
    if (!editor) {
      leanInfoview.updateCursorLocation();
      return;
    }
    leanInfoview.setCursorLocation(embeddedLeanLsp.location(editor));
  }

  function scheduleEmbeddedLeanDiagnosticPull(
    uri: string,
    ticket: DiagnosticGenerationTicket,
    attempt = 0,
  ): void {
    if (!client || disposed || !embeddedLeanDiagnosticGate.isCurrent(ticket)) {
      return;
    }
    if (embeddedLeanDiagnosticTimer) {
      clearTimeout(embeddedLeanDiagnosticTimer);
    }
    embeddedLeanDiagnosticTimer = setTimeout(() => {
      embeddedLeanDiagnosticTimer = null;
      if (!client || disposed || !embeddedLeanDiagnosticGate.isCurrent(ticket)) {
        return;
      }
      const activeClient = client;
      void leanRuntime
        .trackRequest("textDocument/diagnostic", () => activeClient.request<
          { textDocument: { uri: string } },
          { items?: lsp.Diagnostic[]; kind: "full" | "unchanged" }
        >("textDocument/diagnostic", {
          textDocument: { uri },
        }))
        .then((report) => {
          if (
            disposed ||
            !embeddedLeanDiagnosticGate.isCurrent(ticket) ||
            report.kind !== "full"
          ) {
            return;
          }
          applyEmbeddedLeanDiagnostics({
            diagnostics: Array.isArray(report.items) ? report.items : [],
            uri,
          });
          if ((!report.items || report.items.length === 0) && attempt < 11) {
            scheduleEmbeddedLeanDiagnosticPull(uri, ticket, attempt + 1);
          }
        })
        .catch(() => {
          if (
            attempt < 11 &&
            !disposed &&
            embeddedLeanDiagnosticGate.isCurrent(ticket)
          ) {
            scheduleEmbeddedLeanDiagnosticPull(uri, ticket, attempt + 1);
          }
        });
    }, attempt === 0 ? 900 : 700);
  }

  function scheduleRustMainDiagnosticPull(
    uri: string,
    ticket: DiagnosticGenerationTicket,
    attempt = 0,
  ): void {
    if (!rustClient || disposed || !rustMainDiagnosticGate.isCurrent(ticket)) {
      return;
    }
    if (rustMainDiagnosticTimer) {
      clearTimeout(rustMainDiagnosticTimer);
    }
    rustMainDiagnosticTimer = setTimeout(() => {
      rustMainDiagnosticTimer = null;
      if (!rustClient || disposed || !rustMainDiagnosticGate.isCurrent(ticket)) {
        return;
      }
      const activeRustClient = rustClient;
      void rustRuntime
        .trackRequest("textDocument/diagnostic", () => activeRustClient.request<
          { textDocument: { uri: string } },
          { items?: lsp.Diagnostic[]; kind: "full" | "unchanged" }
        >("textDocument/diagnostic", {
          textDocument: { uri },
        }))
        .then((report) => {
          if (
            disposed ||
            !rustMainDiagnosticGate.isCurrent(ticket) ||
            (rustMainPushTicket !== null && rustMainDiagnosticGate.isCurrent(rustMainPushTicket)) ||
            report.kind !== "full"
          ) {
            return;
          }
          applyRustMainDiagnostics({
            diagnostics: Array.isArray(report.items) ? report.items : [],
            uri,
          });
          if ((!report.items || report.items.length === 0) && attempt < 4) {
            scheduleRustMainDiagnosticPull(uri, ticket, attempt + 1);
          }
        })
        .catch(() => {
          if (attempt < 4 && !disposed && rustMainDiagnosticGate.isCurrent(ticket)) {
            scheduleRustMainDiagnosticPull(uri, ticket, attempt + 1);
          }
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
        const version = rustClient?.workspace.getFile(session.rustMainDocumentUri)?.version;
        const ticket = rustMainDiagnosticGate.recordSync(version);
        scheduleRustMainDiagnosticPull(session.rustMainDocumentUri, ticket);
      }
    }, 150);
  }

  function clearRustMainDiagnostics(): void {
    if (currentUri !== session.rustMainDocumentUri || !currentView) {
      return;
    }
    currentView.dispatch(setDiagnostics(currentView.state, []));
  }

  function canRegenerateCurrentRust(): boolean {
    return Boolean(
      session.canRegenerate &&
        session.rustMainDocumentUri &&
        currentUri === session.rustMainDocumentUri &&
        rustMainExtractionFresh === false &&
        !rustMainRegenerationInFlight,
    );
  }

  function clearAutoRegenerationTimer(): void {
    if (!rustMainAutoRegenerateTimer) {
      return;
    }
    clearTimeout(rustMainAutoRegenerateTimer);
    rustMainAutoRegenerateTimer = null;
    setRegenerateControlState();
  }

  function setRegenerateControlState(): void {
    const staticMockup = currentLanguageId === "lean4" && !session.canRegenerate;
    if (staticMockup) options.ui.setExtractionState("Static mock-up", "pending");
    else if (rustMainExtractionFresh !== null && !rustMainRegenerationInFlight) {
      options.ui.setExtractionState(rustMainExtractionFresh ? "Fresh" : "Stale", rustMainExtractionFresh ? "fresh" : "stale");
    }
    const canRegenerate = canRegenerateCurrentRust();
    const autoQueued = Boolean(rustMainAutoRegenerateTimer);
    const enabled = regenerationMode === "manual" && canRegenerate;
    const label = rustMainRegenerationInFlight
      ? "Regenerating"
      : autoQueued
        ? "Queued"
        : "Regenerate";
    options.ui.setRegenerateState({
      busy: rustMainRegenerationInFlight,
      enabled,
      label,
      title: staticMockup ? "Rust and Lean are paired by hand in this static mock-up." : session.canRegenerate
        ? "Regenerate the Anneal workspace from the current Rust source."
        : "Regeneration is only available for manifest-backed Anneal demos.",
    });
  }

  function scheduleAutoRegeneration(source: string): void {
    if (
      regenerationMode !== "auto" ||
      !canRegenerateCurrentRust() ||
      source === suppressedAutoRegenerationSource
    ) {
      setRegenerateControlState();
      return;
    }
    const alreadyQueued = Boolean(rustMainAutoRegenerateTimer);
    if (rustMainAutoRegenerateTimer) {
      clearTimeout(rustMainAutoRegenerateTimer);
    }
    rustMainAutoRegenerateTimer = setTimeout(() => {
      rustMainAutoRegenerateTimer = null;
      setRegenerateControlState();
      if (!disposed && currentView?.state.doc.toString() === source) {
        void regenerateRustMainWorkspace("auto");
      }
    }, autoRegenerationDelayMs);
    if (!alreadyQueued) {
      options.ui.logEvent("Auto regeneration queued after Rust edits settle.");
    }
    setRegenerateControlState();
  }

  function setRegenerationMode(mode: RegenerationMode, logTransition = false): void {
    regenerationMode = session.canRegenerate ? mode : "manual";
    suppressedAutoRegenerationSource = null;
    saveRegenerationMode(regenerationMode);
    options.ui.setRegenerationMode(regenerationMode, Boolean(session.canRegenerate));
    if (regenerationMode === "auto") {
      const source = currentView?.state.doc.toString();
      if (source) {
        scheduleAutoRegeneration(source);
      }
    } else {
      clearAutoRegenerationTimer();
    }
    setRegenerateControlState();
    if (logTransition) {
      options.ui.logEvent(`Regeneration mode set to ${regenerationMode}.`);
    }
  }

  function syncRustMainExtractionState(
    source: string,
    config: { logTransition?: boolean } = {},
  ): boolean {
    if (rustMainRegenerationInFlight) {
      setRegenerateControlState();
      return false;
    }
    if (!session.rustMainDocumentUri) {
      options.ui.setExtractionState("N/A", "pending");
      rustMainExtractionFresh = null;
      setRegenerateControlState();
      return true;
    }
    if (rustMainBaselineFingerprint === null) {
      options.ui.setExtractionState("Checking", "pending");
      rustMainExtractionFresh = null;
      setRegenerateControlState();
      return true;
    }
    const fresh = embeddedLeanHostFingerprint(source) === rustMainBaselineFingerprint;
    const previousFresh = rustMainExtractionFresh;
    rustMainExtractionFresh = fresh;
    options.ui.setExtractionState(fresh ? "Fresh" : "Stale", fresh ? "fresh" : "stale");
    if (fresh) {
      clearAutoRegenerationTimer();
    } else {
      scheduleAutoRegeneration(source);
    }
    setRegenerateControlState();
    if (config.logTransition !== false && fresh !== previousFresh) {
      options.ui.logEvent(
        fresh
          ? "Rust host matches the startup extraction again."
          : "Rust changed outside embedded Lean blocks; generated Lean is stale until regeneration.",
      );
    }
    return fresh;
  }

  function notifyRustMainSaved(): void {
    const uri = session.rustMainDocumentUri;
    if (!uri || lastRustMainSourceSent === null ||
        rustClient?.workspace.getFile(uri)?.doc.toString() !== lastRustMainSourceSent) return;
    rustClient.sync();
    rustClient.notification("textDocument/didSave", {
      textDocument: { uri }, text: lastRustMainSourceSent,
    });
  }

  function scheduleRustMainPersist(uri: string): void {
    if (uri !== session.rustMainDocumentUri || !persistence) return;
    const snapshot = documents.snapshot(uri);
    if (!snapshot) return;
    const extractionFresh = syncRustMainExtractionState(snapshot.text);
    let committed = false;
    void persistence.schedule(snapshot).then(saved => {
      if (!saved || disposed || !documents.isCurrent(saved.snapshot) || saved.receipt.stale) return;
      committed = true;
      const result = saved.receipt;
      lastRustMainSourceSent = saved.snapshot.text;
      notifyRustMainSaved();
      options.ui.setDocumentSyncState(uri, "clean");
      if (result.projectionError) {
        options.ui.setExtractionState("Projection failed", "stale");
        options.ui.logEvent(`Rust source saved; Lean projection failed: ${result.projectionError}`);
        return;
      }
      const embeddedLeanDocument = buildEmbeddedLeanDocument(saved.snapshot.text, {
        defaultImports: session.embeddedLeanDefaultImports ?? [],
        preamble: session.embeddedLeanPreamble ?? [],
        postamble: session.embeddedLeanPostamble ?? [],
        sourceName: uri.split("/").at(-1) ?? "Main.rs",
      });
      lastEmbeddedLeanDocument = embeddedLeanDocument;
      refreshLeanWorkspaceArtifacts(result, embeddedLeanDocument.doc);
      options.ui.logEvent(extractionFresh
        ? "Rust driver saved; Lean snippets refreshed."
        : "Lean snippets refreshed against stale generated Rust context.");
    }).catch(error => {
      if (disposed || !documents.isCurrent(snapshot)) return;
      const message = error instanceof Error ? error.message : String(error);
      options.ui.logEvent(committed ? `Rust source saved; view refresh failed: ${message}` : `Rust driver update failed: ${message}`);
      options.ui.setDocumentSyncState(uri, committed ? "clean" : "failed", message);
    });
  }

  async function regenerateRustMainWorkspace(trigger: RegenerationMode = "manual"): Promise<void> {
    const uri = session.rustMainDocumentUri;
    if (!session.canRegenerate || !uri || currentUri !== uri || !currentView || rustMainRegenerationInFlight) {
      return;
    }
    clearAutoRegenerationTimer();
    persistence?.cancelScheduled();
    rustMainRegenerationInFlight = true;
    options.ui.setExtractionState("Regenerating", "pending");
    options.ui.setDocumentSyncState(uri, "dirty");
    options.ui.setStatus("Regenerating");
    options.ui.logEvent(
      trigger === "auto"
        ? "Auto-regenerating Anneal workspace from current Rust source."
        : "Regenerating Anneal workspace from current Rust source.",
    );
    setRegenerateControlState();

    let restartRequested = false;
    const attempt: { committed: AuthoredSnapshot | null; source: string | null } = { committed: null, source: null };
    let generationFailed = false;
    const job = persistence!.withSavedSnapshot(async saved => {
      if (disposed || !currentView || currentUri !== uri) {
        return;
      }
      const { snapshot, receipt } = saved;
      const source = snapshot.text;
      attempt.committed = snapshot;
      attempt.source = source;
      const revision = receipt.revision;
      const embeddedLeanDocument = buildEmbeddedLeanDocument(source, {
        defaultImports: session.embeddedLeanDefaultImports ?? [],
        preamble: session.embeddedLeanPreamble ?? [],
        postamble: session.embeddedLeanPostamble ?? [],
        sourceName: uri.split("/").at(-1) ?? "Main.rs",
      });
      lastRustMainSourceSent = source;
      options.ui.setDocumentSyncState(uri, documents.isCurrent(snapshot) ? "clean" : "dirty");
      const request = rustRuntime.beginRequest("rust-main/regenerate");
      await options.sessionApi
        .regenerateRustMainDocument({
          diskRevision: receipt.diskRevision,
          code: source,
          revision,
          uri,
        })
        .then(
          (value) => {
            request.succeeded();
            return value;
          },
          (error) => {
            request.failed(error);
            throw error;
          },
        );
      if (disposed) return;
      if (!documents.isCurrent(snapshot)) {
        options.ui.logEvent("Generated output belongs to an earlier Rust revision; newer edits are retained.");
        return;
      }
      lastRustMainSourceSent = source;
      lastEmbeddedLeanDocument = embeddedLeanDocument;
      options.ui.setDocumentSyncState(uri, "clean");
      options.ui.logEvent("Anneal workspace regenerated. Restarting Lean services.");
      options.ui.setExtractionState("Restarting", "pending");
      options.ui.setStatus("Reconnecting");
      restartRequested = true;
      options.requestRestart("Anneal workspace regenerated.");
    });
    try {
      await job;
    } catch (error) {
      if (disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : "Anneal workspace regeneration failed.";
      if (trigger === "auto") {
        suppressedAutoRegenerationSource = attempt.source;
      }
      options.ui.logEvent(`Anneal workspace regeneration failed: ${message}`);
      generationFailed = true;
      options.ui.setDocumentSyncState(uri, attempt.committed
        ? (documents.isCurrent(attempt.committed) ? "clean" : "dirty")
        : "failed", message);
      options.ui.setStatus("Ready");
    } finally {
      rustMainRegenerationInFlight = false;
      if (!disposed && !restartRequested) {
        const source = currentDocumentText(uri) ?? "";
        syncRustMainExtractionState(source, { logTransition: false });
        setRegenerateControlState();
        if (generationFailed) options.ui.setExtractionState("Generation failed", "stale");
      } else if (!disposed) {
        options.ui.setRegenerateState({
          enabled: false,
          title: "Regenerate the Anneal workspace from the current Rust source.",
        });
      }
    }
  }

  function currentDocumentText(uri: string): string | undefined {
    return documents.snapshot(uri)?.text;
  }

  async function mountDocument(uri: string, doc: string): Promise<EditorView> {
    if (disposed) {
      throw new Error("Demo runtime is disposed.");
    }
    const languageId = languageIdForUri(session, uri);
    client?.sync();
    rustClient?.sync();
    const retainedState = documents.state(uri);
    documents.retainActive();
    currentView?.destroy();
    currentView = null;
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
            rustBinding.of(rustClient && uri === session.rustMainDocumentUri
              ? rustClient.plugin(uri, "rust") : []),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                rustMainDiagnosticGate.beginEdit();
                suppressedAutoRegenerationSource = null;
                options.ui.setDocumentSyncState(uri, "dirty");
                clearRustMainDiagnostics();
                scheduleRustMainSync();
                scheduleRustMainPersist(uri);
              }
            }),
          ]
        : lean4({
            highlightStyle: leanFallbackHighlightStyle,
            session: leanSessionOwner,
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
      state: retainedState ?? EditorState.create({
        doc,
        extensions: [
          EditorView.updateListener.of(update => documents.remember(uri, update.state, update.docChanged)),
          ...languageExtensions,
          ...infoviewExtensions,
          options.editorTheme,
          ...embeddedBlockExtensions,
        ],
      }),
    });
    currentView = view;
    documents.remember(uri, view.state);
    if (languageId === "rust" && rustClient && uri === session.rustMainDocumentUri) {
      rustMainDiagnosticGate.recordSync(rustClient.workspace.getFile(uri)?.version);
    }
    options.ui.setCurrentDocument(uri, languageId);
    options.ui.setActiveDocument(uri);
    if (languageId === "rust") {
      const mountedSource = view.state.doc.toString();
      syncRustMainExtractionState(mountedSource, { logTransition: false });
      scheduleRustMainPersist(uri);
    } else {
      setRegenerateControlState();
    }
    return view;
  }

  let lastPreparationMessage = "";

  function logPreparationStatus(status: DemoPreparationStatus): void {
    if (status.message === lastPreparationMessage) {
      return;
    }
    lastPreparationMessage = status.message;
    options.ui.logEvent(status.message);
  }

  async function fetchSessionWithPreparationProgress(): Promise<DemoSession> {
    const sessionResult = options.sessionApi.fetchSession().then(
      (session) => ({ kind: "session" as const, session }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    while (!disposed) {
      const result = await Promise.race([
        sessionResult,
        delay(preparationPollDelayMs).then(() => ({ kind: "tick" as const })),
      ]);
      if (result.kind === "session") {
        return result.session;
      }
      if (result.kind === "error") {
        throw result.error;
      }
      try {
        const status = await options.sessionApi.fetchPreparationStatus();
        logPreparationStatus(status);
        if (status.phase === "failed") {
          options.ui.setStatus("Preparation failed");
          throw new Error(status.message);
        }
        if (status.phase === "preparing") {
          options.ui.setStatus("Preparing");
        }
      } catch (error) {
        if (error instanceof Error && error.message === lastPreparationMessage) {
          throw error;
        }
      }
    }
    throw new Error("Demo runtime is disposed.");
  }

  options.ui.setStatus("Loading session");
  const session = await fetchSessionWithPreparationProgress();
  persistence = new SourcePersistence({
    initialDiskRevision: session.rustMainDiskRevision ?? "",
    currentSnapshot: () => currentUri === session.rustMainDocumentUri ? documents.snapshot(currentUri) : null,
    isCurrent: snapshot => documents.isCurrent(snapshot),
    save: (snapshot, diskRevision, revision) => rustRuntime.trackRequest("rust-main/update", () =>
      options.sessionApi.updateRustMainDocument({ uri: snapshot.uri, code: snapshot.text, diskRevision, revision })),
  });
  const preferredLeanFile = new URLSearchParams(location.search).get("example") === "basic"
    ? "Main.lean" : "AeneasDemo.lean";
  const leanDocumentUri = session.documents.find(uri => uri.endsWith(`/${preferredLeanFile}`)) ??
    session.documents.find(uri => uri.endsWith("/Main.lean"));
  const initialUri = new URLSearchParams(location.search).get("mode") !== "rust" && leanDocumentUri
    ? leanDocumentUri : session.documentUri;
  const initialDoc = initialUri === session.documentUri
    ? session.initialDoc : await options.sessionApi.fetchDocument(initialUri);
  if (session.preparationStatus) {
    logPreparationStatus(session.preparationStatus);
  }
  if (!session.canRegenerate) {
    regenerationMode = "manual";
  }
  options.ui.setRegenerateAction(() => {
    void regenerateRustMainWorkspace();
  });
  options.ui.setRegenerationModeAction((mode) => {
    setRegenerationMode(mode, true);
  });
  options.ui.setRegenerationMode(regenerationMode, Boolean(session.canRegenerate));
  options.ui.setRegenerateState({
    enabled: false,
    title: session.canRegenerate
      ? "Regenerate the Anneal workspace from the current Rust source."
      : "Regeneration is only available for manifest-backed Anneal demos.",
  });
  rustMainBaselineFingerprint = session.rustMainDocumentUri
    ? embeddedLeanHostFingerprint(session.initialDoc)
    : null;
  options.ui.setDemoContext({
    activeExampleLabel:
      session.availableExamples?.find((example) => example.id === session.activeExampleId)?.label ??
      session.activeExampleId ??
      "Default workspace",
    project: session.demoProject,
    summary: session.demoSummary,
    title: session.demoTitle,
  });
  options.ui.renderExampleButtons(
    session.availableExamples ?? [],
    session.activeExampleId,
    options.switchExample,
  );
  options.ui.setRegenerationAvailable(session.canRegenerate === true);
  options.ui.setRootUri(session.rootUri);
  options.ui.setCurrentDocument(initialUri);
  syncRustMainExtractionState(session.initialDoc, { logTransition: false });

  options.ui.setStatus("Connecting to Lean");
  leanRuntime.connecting();
  leanSessionOwner = createLeanEditorSession({
    client: {
      extensions: [
        leanProgress,
        leanInfoviewClientNotifications(() => leanInfoview),
        filterLeanHovers(params => {
          if (!currentView || params.textDocument.uri !== currentUri) return false;
          const { line, character } = params.position;
          const state = currentView.state;
          if (line < 0 || line >= state.doc.lines) return false;
          const sourceLine = state.doc.line(line + 1);
          if (character < 0 || character > sourceLine.length) return false;
          const pos = sourceLine.from + character;
          const block = embeddedEditors.sourceBlockAt(state, pos);
          return !!block?.key.startsWith("rust:") && rustPositionAt(block, pos) !== null;
        }),
      ],
      features: {
        semanticTokens: true,
      },
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          leanInfoview?.forwardServerNotification("textDocument/publishDiagnostics", params);
          if (
            params.uri === session.embeddedLeanDocumentUri &&
            !embeddedLeanDiagnosticGate.acceptsPush(params.version)
          ) {
            return true;
          }
          applyEmbeddedLeanDiagnostics(params);
          return false;
        },
      },
      unhandledNotification(_client, method, params) {
        leanInfoview?.forwardServerNotification(method, params);
      },
      rootUri: session.rootUri,
      sanitizeHTML: sanitizeHtml,
      timeout: 20_000,
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
        onDocumentChange(uri, file, update) {
          // Hidden generated files and workspace edits also update any retained
          // editor state, so reopening cannot reintroduce its older text.
          documents.applyWorkspaceUpdate(uri, file.doc, update);
        },
      }),
    },
  });

  function attachLeanSocketListeners(activeSocket: WebSocket): void {
    const reconnectAfterClose = () => {
      if (disposed || socket !== activeSocket) {
        return;
      }
      void reconnectLean("Lean server connection closed.").catch(() => undefined);
    };
    const reconnectAfterError = () => {
      if (disposed || socket !== activeSocket) {
        return;
      }
      void reconnectLean("Lean WebSocket transport was interrupted.").catch(() => undefined);
    };
    activeSocket.addEventListener("close", reconnectAfterClose);
    activeSocket.addEventListener("error", reconnectAfterError);
    detachLeanSocketListeners = () => {
      activeSocket.removeEventListener("close", reconnectAfterClose);
      activeSocket.removeEventListener("error", reconnectAfterError);
    };
  }

  async function connectLeanGeneration(reconnect: boolean): Promise<void> {
    const owner = leanSessionOwner;
    if (!owner) {
      throw new Error("Lean editor session is unavailable.");
    }
    const nextSocket = await options.sessionApi.connectWebSocket(session.websocketUrl);
    if (disposed) {
      nextSocket.close();
      throw new Error("Demo runtime was disposed while connecting to Lean.");
    }

    leanInitializeResult = null;
    leanRuntime.initializing();
    const transport = observeInitializeResult(
      createWebSocketTransport(nextSocket),
      (result) => {
        leanInitializeResult = result;
      },
    );
    const connectOptions = {
      disposeTransport() {
        nextSocket.close();
      },
    };
    const connection = reconnect
      ? owner.reconnect(transport, connectOptions)
      : owner.connect(transport, connectOptions);
    socket = nextSocket;
    client = connection.client;
    workspace = connection.client.workspace as LeanWorkspace;
    await connection.initialized;
    attachLeanSocketListeners(nextSocket);
  }

  async function activateLeanInfoviewGeneration(): Promise<void> {
    const activeClient = client;
    const activeWorkspace = workspace;
    if (!activeClient || !activeWorkspace || !leanInfoview) {
      return;
    }
    leanInfoview.serverRestarted(leanInitializeResult ?? undefined);
    if (session.embeddedLeanDocumentUri) {
      embeddedLeanServerLease?.release();
      embeddedLeanServerLease = await activeWorkspace.acquireServerDocument(
        session.embeddedLeanDocumentUri,
      );
      embeddedLeanDiagnosticGate.recordSync(embeddedLeanServerLease?.file.version);
    }
    leanInfoview.updateCursorLocation();
  }

  async function reconnectLean(reason: string): Promise<void> {
    if (disposed) {
      throw new Error("Cannot reconnect a disposed demo runtime.");
    }
    if (leanReconnectPromise) {
      return leanReconnectPromise;
    }

    const reconnecting = (async () => {
      options.ui.setStatus("Reconnecting");
      leanRuntime.recordConnectionStatus({ phase: "stale", message: "Reconnecting" });
      options.ui.logEvent(reason);
      detachLeanSocketListeners?.();
      detachLeanSocketListeners = null;
      leanInfoview?.serverStopped({
        message: "Lean server stopped.",
        reason,
      });
      embeddedLeanServerLease?.release();
      embeddedLeanServerLease = null;

      try {
        await connectLeanGeneration(true);
        await activateLeanInfoviewGeneration();
        leanRuntime.ready();
        options.ui.setStatus("Ready");
        options.ui.logEvent("Lean server reconnected without remounting the editor.");
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          options.ui.logEvent(`Lean generation reconnect failed: ${message}`);
          options.requestRestart(`Lean generation reconnect failed: ${message}`);
        }
        throw error;
      }
    })();
    leanReconnectPromise = reconnecting;
    try {
      await reconnecting;
    } finally {
      if (leanReconnectPromise === reconnecting) {
        leanReconnectPromise = null;
      }
    }
  }

  await connectLeanGeneration(false);
  leanRuntime.ready();
  leanInfoview = createLeanInfoviewHost({
    client() {
      return client;
    },
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
    requestRestart(reason) {
      void reconnectLean(reason).catch(() => undefined);
    },
    workspace() {
      return workspace;
    },
  });
  await activateLeanInfoviewGeneration();

  function rebindRust(client: LSPClient | null): void {
    const uri = session.rustMainDocumentUri;
    if (!uri) return;
    const effect = rustBinding.reconfigure(client ? client.plugin(uri, "rust") : []);
    if (currentUri === uri && currentView) {
      currentView.dispatch({ selection: currentView.state.selection });
      currentView.dispatch({ effects: effect });
    }
    else {
      const state = documents.state(uri);
      if (state) documents.remember(uri, state.update({ effects: effect }).state);
    }
  }

  let rustConnection = new ConnectionScope<{ client: LSPClient; socket: WebSocket }>();
  async function connectRustGeneration(): Promise<void> {
    if (!session.rustMainWebsocketUrl) return;
    const scope = rustConnection;
    await scope.open(async () => {
      rustRuntime.connecting();
      const nextSocket = await options.sessionApi.connectWebSocket(session.rustMainWebsocketUrl!, scope.signal);
      scope.own(() => nextSocket.close());
      nextSocket.addEventListener("close", () => scope.dispose(), { once: true });
      nextSocket.addEventListener("error", () => scope.dispose(), { once: true });
      if (disposed || scope.disposed) throw new Error("Rust generation retired");
      rustRuntime.initializing();
      const nextClient = new LSPClient({
        extensions: [
          rustProgress, ...languageServerExtensions(),
          { clientCapabilities: { experimental: { serverStatusNotification: true } } },
        ],
        notificationHandlers: {
          "experimental/serverStatus": (_client, params: { quiescent?: boolean }) => {
            // Workspace loading can discard Cargo results from an early save.
            // Recheck the saved buffer once loading finishes. Cargo checks do not
            // change this workspace-loading state, so this cannot form a loop.
            if (rustClient === _client && params.quiescent === true) notifyRustMainSaved();
            return true;
          },
          "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
            if (scope !== rustConnection || scope.disposed || rustClient !== _client) return true;
            if (
              params.uri === session.rustMainDocumentUri &&
              !rustMainDiagnosticGate.acceptsPush(params.version)
            ) {
              return true;
            }
            // rust-analyzer's pulls omit Cargo diagnostics. Once a push is
            // accepted for this version, an empty native pull must not erase it.
            if (params.uri === session.rustMainDocumentUri) {
              rustMainPushTicket = rustMainDiagnosticGate.ticket();
            }
            return applyRustMainDiagnostics(params);
          },
        },
        rootUri: session.rustRootUri ?? session.rootUri,
        sanitizeHTML: sanitizeHtml,
        timeout: 20_000,
      });
      scope.own(() => nextClient.disconnect());
      nextClient.connect(rustProgress.wrapTransport(createWebSocketTransport(nextSocket)));
      await nextClient.initializing;
      if (disposed || scope !== rustConnection || scope.disposed) throw new Error("Rust generation retired");
      rustClient = nextClient;
      rustSocket = nextSocket;
      rebindRust(nextClient);
      const interrupted = () => {
        if (!disposed && rustSocket === nextSocket) void reconnectRust();
      };
      nextSocket.addEventListener("close", interrupted, { once: true });
      nextSocket.addEventListener("error", interrupted, { once: true });
      rustRuntime.ready();
      notifyRustMainSaved();
      options.ui.logEvent("rust-analyzer initialized.");
      return { client: nextClient, socket: nextSocket };
    }).catch(error => {
      if (rustConnection === scope && !disposed) rustConnection = new ConnectionScope();
      throw error;
    });
  }

  function reconnectRust(): Promise<void> {
    if (rustReconnectPromise) return rustReconnectPromise;
    rustRuntime.recordConnectionStatus({ phase: "stale", message: "Reconnecting" });
    rustMainDiagnosticGate.beginEdit();
    rebindRust(null);
    rustConnection.dispose();
    rustConnection = new ConnectionScope();
    rustSocket = null;
    rustClient = null;
    rustProgress.clear();
    rustReconnectPromise = (async () => {
      for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
        try {
          await connectRustGeneration();
          if (session.rustMainDocumentUri) {
            rustMainDiagnosticGate.recordSync((rustClient as LSPClient | null)?.workspace.getFile(session.rustMainDocumentUri)?.version);
          }
          options.ui.logEvent("Rust server reconnected; editor state preserved.");
          return;
        } catch (error) {
          rustConnection.dispose();
          rustConnection = new ConnectionScope();
          if (attempt === 2) {
            rustRuntime.recordConnectionStatus({ phase: "failed", message: String(error) });
            options.ui.logEvent(`Rust reconnect failed: ${String(error)}`);
          } else await delay(250 * (attempt + 1));
        }
      }
    })().finally(() => { rustReconnectPromise = null; });
    return rustReconnectPromise;
  }

  const openDocument = async (uri: string): Promise<void> => {
    const activation = ++activationRevision;
    if (uri === currentUri && currentView) return;
    if (languageIdForUri(session, uri) === "rust" && !rustClient && session.rustMainWebsocketUrl) await connectRustGeneration();
    const retained = currentDocumentText(uri);
    const file = languageIdForUri(session, uri) === "rust"
      ? rustClient?.workspace.getFile(uri) : await workspace?.requestFile(uri);
    const doc = retained ?? file?.doc.toString() ?? (await options.sessionApi.fetchDocument(uri));
    if (disposed || activation !== activationRevision) return;
    await mountDocument(uri, doc);
    options.ui.logEvent(`Opened ${uri.split("/").at(-1) ?? uri}`);
  };

  demoBridge.install(openDocument);
  options.ui.renderDocumentButtons(session.documents, openDocument);
  if (languageIdForUri(session, initialUri) === "rust") await connectRustGeneration();
  await mountDocument(initialUri, initialDoc);
  leanInfoview.updateCursorLocation();

  const handleBeforeUnload = () => {
    runtime.dispose();
  };

  window.addEventListener("beforeunload", handleBeforeUnload);

  options.ui.setStatus("Ready");
  options.ui.logEvent("Lean server initialized.");

  const runtime: DemoRuntime = {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      persistence?.dispose();
      if (rustMainAutoRegenerateTimer) {
        clearTimeout(rustMainAutoRegenerateTimer);
        rustMainAutoRegenerateTimer = null;
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
      options.ui.setRegenerateAction(null);
      options.ui.setRegenerateState({ enabled: false });
      options.ui.setRegenerationModeAction(null);
      options.ui.setRegenerationMode("manual", false);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      detachLeanSocketListeners?.();
      detachLeanSocketListeners = null;
      embeddedEditors.close();
      currentView?.destroy();
      currentView = null;
      documents.clear();
      demoBridge.clear();
      embeddedLeanServerLease?.release();
      embeddedLeanServerLease = null;
      leanInfoview?.serverStopped({ message: "Lean server stopped.", reason: "Demo runtime disposed." });
      leanInfoview?.dispose();
      leanInfoview = null;
      leanSessionOwner?.dispose();
      leanSessionOwner = null;
      leanRuntime.stopped();
      rustConnection.dispose();
      rustProgress.clear();
      rustRuntime.stopped();
      socket = null;
      rustSocket = null;
      workspace = null;
      client = null;
      rustClient = null;
    },
  };

  return runtime;
}
