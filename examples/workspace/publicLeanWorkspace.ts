import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession, createLeanWorkspace, createWebSocketTransport,
  detectLeanLineEnding, lean4, leanFallbackHighlightStyle, leanFileProgress, waitForWebSocketOpen,
  type LeanEditorSession, type LeanLineEnding, type LeanEditorSessionState, type LeanWorkspace,
} from "codemirror-lean4-lsp";
import {
  createLeanInfoviewHost, leanInfoviewClientNotifications, type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import "codemirror-lean4-lsp/infoview.css";
import type * as lsp from "vscode-languageserver-protocol";

export interface WorkspaceDocument {
  uri: string;
  text: string;
  revision: string;
}
export interface WorkspaceDocumentState {
  uri: string;
  dirty: boolean;
  saving: boolean;
  error?: string;
}
/** Lean's processing outcome for a document; independent of the connection. */
export interface WorkspaceCheckingState {
  uri: string;
  phase: "checking" | "checked" | "failed";
}
export interface MountLeanWorkspaceOptions {
  documents: readonly WorkspaceDocument[];
  editorContainer: HTMLElement;
  infoviewContainer: HTMLElement;
  rootUri: string;
  websocketUrl: string;
  /** Aborting disposes the workspace, including while it is still connecting. */
  signal?: AbortSignal;
  saveDocument(document: WorkspaceDocument): Promise<WorkspaceDocument>;
  onActiveDocument?(uri: string): void;
  onDocumentState?(state: WorkspaceDocumentState): void;
  onCheckingState?(state: WorkspaceCheckingState): void;
  onDiagnostics?(params: lsp.PublishDiagnosticsParams): void;
  onSessionState?(state: LeanEditorSessionState): void;
  onReconnectStart?(reason: string): void;
  onError?(error: unknown): void;
  sanitizeHTML?(html: string): string;
}
export interface MountedLeanWorkspace {
  /**
   * Settles when the first Lean connection is ready. Rejects with an
   * `AbortError` if the workspace is disposed first, or with the last
   * connection error; editors stay usable offline and `reconnect()` can retry.
   */
  readonly ready: Promise<void>;
  readonly session: LeanEditorSession;
  readonly currentUri: string;
  readonly currentView: EditorView;
  showDocument(uri: string): EditorView;
  saveAll(): Promise<void>;
  reconnect(reason?: string): Promise<void>;
  dispose(): void;
}
interface DocumentEntry {
  readonly uri: string;
  revision: string;
  /** Detected from the loaded text and used when saving, as VS Code does. */
  readonly lineEnding: LeanLineEnding;
  /** Current editor text, kept when the view or Lean connection goes away. */
  draft: Text;
  /** Text last loaded from or saved to disk. */
  saved: Text;
  view?: EditorView;
  panel?: HTMLElement;
  saving: boolean;
  error?: string;
}

function workspaceDisposedError(): DOMException {
  return new DOMException("Workspace is disposed.", "AbortError");
}

/**
 * A host composition over public toolkit entries, with one retained view per URI.
 * Editors mount immediately; Lean connects in the background (see `ready`).
 */
export function mountLeanWorkspace(options: MountLeanWorkspaceOptions): MountedLeanWorkspace {
  const first = options.documents[0];
  if (!first) throw new Error("A workspace needs at least one document.");
  if (options.signal?.aborted) throw workspaceDisposedError();
  const documents = new Map<string, DocumentEntry>();
  for (const document of options.documents) {
    if (documents.has(document.uri)) throw new Error("Duplicate workspace document URI.");
    // Split like CodeMirror, so dirty state compares logical content: a
    // mixed-ending file stays clean after edit-and-undo and is normalized to
    // its majority ending only when an edit is saved.
    const saved = Text.of(document.text.split(/\r\n?|\n/));
    documents.set(document.uri, {
      uri: document.uri, revision: document.revision,
      lineEnding: detectLeanLineEnding(document.text),
      draft: saved, saved, saving: false,
    });
  }
  let activeUri = first.uri;
  let socket: WebSocket | null = null;
  let disposed = false;
  let connecting: Promise<void> | null = null;
  let saving: Promise<void> | null = null;

  function emitDocument(entry: DocumentEntry): void {
    if (disposed) return;
    options.onDocumentState?.({
      uri: entry.uri, dirty: !entry.draft.eq(entry.saved), saving: entry.saving,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }
  const infoviewNotifications = leanInfoviewClientNotifications(() => infoview);
  const fileProgress = leanFileProgress({
    onUpdate(update) {
      if (!disposed && update.uri && documents.has(update.uri)) {
        options.onCheckingState?.({
          uri: update.uri,
          phase: update.state?.hasFatalError ? "failed" : update.state?.isProcessing ? "checking" : "checked",
        });
      }
    },
  });
  const session = createLeanEditorSession({
    client: {
      rootUri: options.rootUri,
      features: { semanticTokens: true },
      extensions: [infoviewNotifications, fileProgress],
      ...(options.sanitizeHTML ? { sanitizeHTML: options.sanitizeHTML } : {}),
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          infoview.forwardServerNotification("textDocument/publishDiagnostics", params);
          options.onDiagnostics?.(params);
          return false;
        },
      },
      unhandledNotification(_client, method, params) {
        infoview.forwardServerNotification(method, params);
      },
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          const entry = documents.get(uri);
          return entry ? { doc: entry.draft } : null;
        },
        displayDocument(uri) {
          return documents.has(uri) ? showDocument(uri) : null;
        },
        onDocumentChange(uri, file) {
          const entry = documents.get(uri);
          if (entry) {
            entry.draft = file.doc;
            emitDocument(entry);
          }
        },
      }),
    },
  });
  const unsubscribe = session.subscribe((state) => options.onSessionState?.(state), { emitCurrent: true });
  const infoview: LeanInfoviewHost = createLeanInfoviewHost({
    client: () => session.client,
    container: options.infoviewContainer,
    currentLanguageId: () => "lean4",
    currentUri: () => activeUri,
    currentView: () => documents.get(activeUri)?.view ?? null,
    requestRestart: (reason) => { void reconnect(reason).catch(() => undefined); },
    workspace: () => (session.client?.workspace as LeanWorkspace | undefined) ?? null,
  });

  function showDocument(uri: string): EditorView {
    if (disposed) throw workspaceDisposedError();
    const entry = documents.get(uri);
    if (!entry) throw new Error("Document is outside the host workspace.");
    if (!entry.view) {
      const panel = document.createElement("div");
      panel.className = "workspace-editor-panel";
      panel.dataset.uri = uri;
      options.editorContainer.append(panel);
      entry.panel = panel;
      entry.view = new EditorView({
        parent: panel,
        state: EditorState.create({
          doc: entry.draft,
          extensions: [
            ...lean4({ session, uri, utilities: true, highlightStyle: leanFallbackHighlightStyle }),
            infoview.editorExtension(),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                entry.draft = update.state.doc;
                delete entry.error;
                emitDocument(entry);
              }
            }),
            EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
          ],
        }),
      });
    }
    activeUri = uri;
    for (const candidate of documents.values()) {
      if (candidate.panel) candidate.panel.hidden = candidate.uri !== uri;
    }
    options.onActiveDocument?.(uri);
    entry.view.requestMeasure();
    entry.view.focus();
    infoview.updateCursorLocation();
    return entry.view;
  }

  async function connect(): Promise<void> {
    const next = new WebSocket(options.websocketUrl);
    socket = next;
    try {
      await waitForWebSocketOpen(next);
      if (disposed) throw workspaceDisposedError();
      const connection = session.connect(createWebSocketTransport(next), {
        disposeTransport: () => next.close(),
      });
      await connection.initialized;
      next.addEventListener("close", () => {
        if (!disposed && socket === next && !connecting) {
          void reconnect("Lean server connection closed.").catch(() => undefined);
        }
      }, { once: true });
    } catch (error) {
      next.close();
      throw error;
    }
  }

  /** Connect with retries; a disposed workspace stops with an AbortError. */
  async function connectWithRetries(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      if (disposed) throw workspaceDisposedError();
      try {
        await connect();
        if (disposed) throw workspaceDisposedError();
        infoview.serverRestarted();
        infoview.updateCursorLocation();
        return;
      } catch (error) {
        if (disposed) throw workspaceDisposedError();
        lastError = error;
        session.disconnect();
      }
    }
    options.onError?.(lastError);
    throw lastError;
  }

  /** Startup and reconnect share one task, including its pending socket and retries. */
  function startConnecting(): Promise<void> {
    const task = connectWithRetries();
    connecting = task;
    void task.finally(() => {
      if (connecting === task) connecting = null;
    }).catch(() => undefined);
    return task;
  }

  function reconnect(reason = "Reconnect requested"): Promise<void> {
    if (disposed) return Promise.reject(workspaceDisposedError());
    if (connecting) return connecting;
    options.onReconnectStart?.(reason);
    infoview.serverStopped({ message: "Lean is reconnecting.", reason });
    // Detach old plugins and RPC work immediately; editor documents and history stay mounted.
    session.disconnect();
    return startConnecting();
  }

  function saveAll(): Promise<void> {
    if (disposed) return Promise.reject(workspaceDisposedError());
    if (saving) return saving;
    const task = (async () => {
      for (const entry of documents.values()) {
        if (entry.draft.eq(entry.saved)) continue;
        // Save this exact snapshot; edits made while the save is in flight stay dirty.
        const doc = entry.draft;
        entry.saving = true;
        delete entry.error;
        emitDocument(entry);
        try {
          const text = doc.sliceString(0, doc.length, entry.lineEnding);
          const saved = await options.saveDocument({ uri: entry.uri, text, revision: entry.revision });
          entry.revision = saved.revision;
          entry.saved = doc;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          entry.saving = false;
          emitDocument(entry);
        }
      }
    })();
    saving = task;
    void task.finally(() => {
      if (saving === task) saving = null;
    }).catch(() => undefined);
    return task;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    unsubscribe();
    infoview.dispose();
    for (const entry of documents.values()) {
      entry.view?.destroy();
      entry.panel?.remove();
    }
    session.dispose();
    // Closing a still-connecting socket rejects the pending startup.
    socket?.close();
  }

  options.signal?.addEventListener("abort", dispose, { once: true });
  showDocument(activeUri);
  for (const entry of documents.values()) emitDocument(entry);
  const ready = startConnecting();
  // Callers may ignore `ready`; failures are also reported through onError.
  void ready.catch(() => undefined);

  return {
    ready, session, showDocument, saveAll, reconnect, dispose,
    get currentUri() { return activeUri; },
    get currentView() { return documents.get(activeUri)!.view!; },
  };
}
