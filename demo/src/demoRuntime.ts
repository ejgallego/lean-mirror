import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { LSPClient, LSPPlugin, languageServerExtensions } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";
import { EditorServiceRuntime, type EditorDiagnostic, type EditorServiceDescriptor } from "@leanprover/editor-platform";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import { Marked } from "marked";

import {
  createLeanEditorSession,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanFileProgress,
  leanFallbackHighlightStyle,
  leanUtilities,
  type Transport,
  type LeanEditorSession,
  type LeanServerDocumentLease,
  type LeanWorkspace,
} from "../../src/index.js";
import { workDoneProgress, type WorkDoneProgressState } from "../../src/progress.js";
import { createDemoBridge } from "./demoBridge.js";
import {
  DiagnosticGenerationGate,
  type DiagnosticGenerationTicket,
} from "./diagnosticGeneration.js";
import type { DemoExample, DemoPreparationStatus, DemoSession, DemoSessionApi } from "./demoSession.js";
import type { DemoUi, RegenerationMode } from "./demoUi.js";
import {
  buildEmbeddedLeanDocument,
  embeddedLeanHostFingerprint,
  mapEmbeddedLeanDiagnostics,
  type EmbeddedLeanDocument,
} from "./embeddedLean.js";
import { createEmbeddedEditorShell, type ActiveEmbeddedEditor } from "./embeddedEditorShell.js";
import type { AnyEmbeddedBlockEditorAdapter, EmbeddedBlockDiagnostic } from "./embeddedBlocks.js";
import { sanitizeHtml } from "./sanitizeHtml.js";

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

const regenerationModeStorageKey = "lean-demo-regeneration-mode";
const autoRegenerationDelayMs = 1400;
const preparationPollDelayMs = 500;
const leanHoverMarkdown = new Marked();

function loadRegenerationMode(): RegenerationMode {
  try {
    return window.localStorage.getItem(regenerationModeStorageKey) === "auto" ? "auto" : "manual";
  } catch {
    return "manual";
  }
}

function saveRegenerationMode(mode: RegenerationMode): void {
  try {
    window.localStorage.setItem(regenerationModeStorageKey, mode);
  } catch {
    // Ignore storage failures; mode still applies to the current runtime.
  }
}

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
  switchExample(example: DemoExample): Promise<void>;
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
  let client: LSPClient | null = null;
  let leanSessionOwner: LeanEditorSession | null = null;
  let embeddedLeanServerLease: LeanServerDocumentLease | null = null;
  let leanInfoview: LeanInfoviewHost | null = null;
  let rustClient: LSPClient | null = null;
  let socket: WebSocket | null = null;
  let rustSocket: WebSocket | null = null;
  let detachLeanSocketListeners: (() => void) | null = null;
  let leanReconnectPromise: Promise<void> | null = null;
  let disposed = false;
  let embeddedLeanDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainAutoRegenerateTimer: ReturnType<typeof setTimeout> | null = null;
  let rustMainRevision = 0;
  let rustMainQueue = Promise.resolve();
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
    return typeof html === "string" ? sanitizeHtml(html) : "";
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
      title: session.canRegenerate
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

  function scheduleRustMainPersist(session: DemoSession, uri: string, source: string): void {
    if (uri !== session.rustMainDocumentUri) {
      return;
    }
    const extractionFresh = syncRustMainExtractionState(source);
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
        defaultImports: session.embeddedLeanDefaultImports ?? [],
        preamble: session.embeddedLeanPreamble ?? [],
        postamble: session.embeddedLeanPostamble ?? [],
        sourceName: uri.split("/").at(-1) ?? "Main.rs",
      });
      const leanDocument = embeddedLeanDocument.doc;
      rustMainQueue = rustMainQueue
        .then(async () => {
          if (disposed || revision !== rustMainRevision) {
            return;
          }
          const result = await rustRuntime.trackRequest(
            "rust-main/update",
            () => options.sessionApi.updateRustMainDocument({
              code: source,
              leanDocument,
              revision,
              uri,
            }),
          );
          if (disposed || result.stale || revision !== rustMainRevision) {
            return;
          }
          lastRustMainSourceSent = source;
          lastEmbeddedLeanDocument = embeddedLeanDocument;
          refreshLeanWorkspaceArtifacts(result, leanDocument);
          options.ui.setDocumentSyncState(uri, "clean");
          options.ui.logEvent(
            extractionFresh
              ? "Rust driver saved; Lean snippets refreshed."
              : "Lean snippets refreshed against stale generated Rust context.",
          );
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

  async function regenerateRustMainWorkspace(trigger: RegenerationMode = "manual"): Promise<void> {
    const uri = session.rustMainDocumentUri;
    if (!session.canRegenerate || !uri || currentUri !== uri || !currentView || rustMainRegenerationInFlight) {
      return;
    }
    clearAutoRegenerationTimer();
    if (rustMainPersistTimer) {
      clearTimeout(rustMainPersistTimer);
      rustMainPersistTimer = null;
    }
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
    const job = rustMainQueue.then(async () => {
      if (disposed || !currentView || currentUri !== uri) {
        return;
      }
      const source = currentView.state.doc.toString();
      const revision = ++rustMainRevision;
      const embeddedLeanDocument = buildEmbeddedLeanDocument(source, {
        defaultImports: session.embeddedLeanDefaultImports ?? [],
        preamble: session.embeddedLeanPreamble ?? [],
        postamble: session.embeddedLeanPostamble ?? [],
        sourceName: uri.split("/").at(-1) ?? "Main.rs",
      });
      const request = rustRuntime.beginRequest("rust-main/regenerate");
      await options.sessionApi
        .regenerateRustMainDocument({
          code: source,
          leanDocument: embeddedLeanDocument.doc,
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
      if (disposed) {
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
    rustMainQueue = job.catch(() => {});
    try {
      await job;
    } catch (error) {
      if (disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : "Anneal workspace regeneration failed.";
      if (trigger === "auto") {
        suppressedAutoRegenerationSource = currentView?.state.doc.toString() ?? null;
      }
      options.ui.logEvent(`Anneal workspace regeneration failed: ${message}`);
      options.ui.setDocumentSyncState(uri, "failed", message);
      options.ui.setStatus("Ready");
    } finally {
      rustMainRegenerationInFlight = false;
      if (!disposed && !restartRequested) {
        const source = currentView?.state.doc.toString() ?? "";
        syncRustMainExtractionState(source, { logTransition: false });
        setRegenerateControlState();
      } else if (!disposed) {
        options.ui.setRegenerateState({
          enabled: false,
          title: "Regenerate the Anneal workspace from the current Rust source.",
        });
      }
    }
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
                rustMainDiagnosticGate.beginEdit();
                suppressedAutoRegenerationSource = null;
                options.ui.setDocumentSyncState(uri, "dirty");
                clearRustMainDiagnostics();
                scheduleRustMainSync();
                scheduleRustMainPersist(session, uri, update.state.doc.toString());
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
    if (languageId === "rust" && rustClient && uri === session.rustMainDocumentUri) {
      rustMainDiagnosticGate.recordSync(rustClient.workspace.getFile(uri)?.version);
    }
    options.ui.setCurrentDocument(uri, languageId);
    options.ui.setActiveDocument(uri);
    if (languageId === "rust") {
      syncRustMainExtractionState(doc, { logTransition: false });
      scheduleRustMainPersist(session, uri, doc);
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
  options.ui.setRootUri(session.rootUri);
  options.ui.setCurrentDocument(session.documentUri);
  syncRustMainExtractionState(session.initialDoc, { logTransition: false });

  options.ui.setStatus("Connecting to Lean");
  leanRuntime.connecting();
  leanSessionOwner = createLeanEditorSession({
    client: {
      extensions: [
        leanProgress,
        leanInfoviewClientNotifications(() => leanInfoview),
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

  if (session.rustMainWebsocketUrl) {
    rustRuntime.connecting();
    rustSocket = await options.sessionApi.connectWebSocket(session.rustMainWebsocketUrl);
    rustRuntime.initializing();
    rustClient = new LSPClient({
      extensions: [rustProgress, ...languageServerExtensions()],
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          if (
            params.uri === session.rustMainDocumentUri &&
            !rustMainDiagnosticGate.acceptsPush(params.version)
          ) {
            return true;
          }
          return applyRustMainDiagnostics(params);
        },
      },
      rootUri: session.rustRootUri ?? session.rootUri,
      sanitizeHTML: sanitizeHtml,
      timeout: 20_000,
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
      if (rustMainPersistTimer) {
        clearTimeout(rustMainPersistTimer);
        rustMainPersistTimer = null;
      }
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
      demoBridge.clear();
      embeddedLeanServerLease?.release();
      embeddedLeanServerLease = null;
      leanInfoview?.serverStopped({ message: "Lean server stopped.", reason: "Demo runtime disposed." });
      leanInfoview?.dispose();
      leanInfoview = null;
      leanSessionOwner?.dispose();
      leanSessionOwner = null;
      leanRuntime.stopped();
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
