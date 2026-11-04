import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession, createLeanWorkspace, createWebSocketTransport,
  lean4, leanFallbackHighlightStyle, waitForWebSocketOpen,
  type LeanEditorSession, type LeanEditorSessionState, type LeanWorkspace,
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
export interface MountLeanWorkspaceOptions {
  documents: readonly WorkspaceDocument[];
  editorContainer: HTMLElement;
  infoviewContainer: HTMLElement;
  rootUri: string;
  websocketUrl: string;
  saveDocument(document: WorkspaceDocument): Promise<WorkspaceDocument>;
  onActiveDocument?(uri: string): void;
  onDocumentState?(state: WorkspaceDocumentState): void;
  onDiagnostics?(params: lsp.PublishDiagnosticsParams): void;
  onSessionState?(state: LeanEditorSessionState): void;
  onReconnectStart?(reason: string): void;
  onError?(error: unknown): void;
  sanitizeHTML?(html: string): string;
}
export interface MountedLeanWorkspace {
  readonly session: LeanEditorSession;
  readonly currentUri: string;
  readonly currentView: EditorView;
  showDocument(uri: string): EditorView;
  saveAll(): Promise<void>;
  reconnect(reason?: string): Promise<void>;
  dispose(): void;
}
interface DocumentEntry extends WorkspaceDocument {
  savedText: string;
  view?: EditorView;
  panel?: HTMLElement;
  saving: boolean;
  error?: string;
}

/** A host composition over public toolkit entries, with one retained view per URI. */
export async function mountLeanWorkspace(options: MountLeanWorkspaceOptions): Promise<MountedLeanWorkspace> {
  const first = options.documents[0];
  if (!first) throw new Error("A workspace needs at least one document.");
  const documents = new Map<string, DocumentEntry>();
  for (const document of options.documents) {
    if (documents.has(document.uri)) throw new Error("Duplicate workspace document URI.");
    documents.set(document.uri, { ...document, savedText: document.text, saving: false });
  }
  let activeUri = first.uri;
  let infoview: LeanInfoviewHost | null = null;
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnecting: Promise<void> | null = null;
  let saving: Promise<void> | null = null;

  function emitDocument(entry: DocumentEntry): void {
    if (disposed) return;
    options.onDocumentState?.({
      uri: entry.uri, dirty: entry.text !== entry.savedText, saving: entry.saving,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }
  const session = createLeanEditorSession({
    client: {
      rootUri: options.rootUri,
      timeout: 10_000,
      features: { semanticTokens: true },
      extensions: [leanInfoviewClientNotifications(() => infoview)],
      ...(options.sanitizeHTML ? { sanitizeHTML: options.sanitizeHTML } : {}),
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          infoview?.forwardServerNotification("textDocument/publishDiagnostics", params);
          options.onDiagnostics?.(params);
          return false;
        },
      },
      unhandledNotification(_client, method, params) {
        infoview?.forwardServerNotification(method, params);
      },
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          const entry = documents.get(uri);
          return entry ? { doc: entry.text } : null;
        },
        displayDocument(uri) {
          return documents.has(uri) ? showDocument(uri) : null;
        },
        onDocumentChange(uri, file) {
          const entry = documents.get(uri);
          if (entry) {
            entry.text = file.doc.toString();
            emitDocument(entry);
          }
        },
      }),
    },
  });
  const unsubscribe = session.subscribe((state) => options.onSessionState?.(state), { emitCurrent: true });

  function showDocument(uri: string): EditorView {
    if (disposed) throw new Error("Workspace is disposed.");
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
          doc: entry.text,
          extensions: [
            ...lean4({ session, uri, utilities: true, highlightStyle: leanFallbackHighlightStyle }),
            ...(infoview ? [infoview.editorExtension()] : []),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                entry.text = update.state.doc.toString();
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
    infoview?.updateCursorLocation();
    return entry.view;
  }

  async function connect(): Promise<void> {
    const next = new WebSocket(options.websocketUrl);
    socket = next;
    try {
      await waitForWebSocketOpen(next);
      if (disposed) throw new Error("Workspace is disposed.");
      const connection = session.connect(createWebSocketTransport(next), {
        disposeTransport: () => next.close(),
      });
      await connection.initialized;
      next.addEventListener("close", () => {
        if (!disposed && socket === next && !reconnecting) {
          void reconnect("Lean server connection closed.").catch(() => undefined);
        }
      }, { once: true });
    } catch (error) {
      next.close();
      throw error;
    }
  }

  function reconnect(reason = "Reconnect requested"): Promise<void> {
    if (disposed) return Promise.reject(new Error("Workspace is disposed."));
    if (reconnecting) return reconnecting;
    options.onReconnectStart?.(reason);
    infoview?.serverStopped({ message: "Lean is reconnecting.", reason });
    // Detach old plugins and RPC work immediately; editor documents and history stay mounted.
    session.disconnect();
    const task = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        if (disposed) throw new Error("Workspace is disposed.");
        try {
          await connect();
          infoview?.serverRestarted();
          infoview?.updateCursorLocation();
          return;
        } catch (error) {
          lastError = error;
          session.disconnect();
        }
      }
      options.onError?.(lastError);
      throw lastError;
    })();
    reconnecting = task;
    void task.finally(() => {
      if (reconnecting === task) reconnecting = null;
    }).catch(() => undefined);
    return task;
  }

  function saveAll(): Promise<void> {
    if (disposed) return Promise.reject(new Error("Workspace is disposed."));
    if (saving) return saving;
    const task = (async () => {
      for (const entry of documents.values()) {
        if (entry.text === entry.savedText) continue;
        const text = entry.text;
        entry.saving = true;
        delete entry.error;
        emitDocument(entry);
        try {
          const saved = await options.saveDocument({ uri: entry.uri, text, revision: entry.revision });
          entry.revision = saved.revision;
          entry.savedText = text;
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
    unsubscribe();
    infoview?.dispose();
    for (const entry of documents.values()) {
      entry.view?.destroy();
      entry.panel?.remove();
    }
    session.dispose();
    socket?.close();
  }

  try {
    await connect();
    infoview = createLeanInfoviewHost({
      client: () => session.client,
      container: options.infoviewContainer,
      currentLanguageId: () => "lean4",
      currentUri: () => activeUri,
      currentView: () => documents.get(activeUri)?.view ?? null,
      requestRestart: (reason) => { void reconnect(reason).catch(() => undefined); },
      workspace: () => (session.client?.workspace as LeanWorkspace | undefined) ?? null,
    });
    infoview.serverRestarted();
    showDocument(activeUri);
    for (const entry of documents.values()) emitDocument(entry);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    session, showDocument, saveAll, reconnect, dispose,
    get currentUri() { return activeUri; },
    get currentView() { return documents.get(activeUri)!.view!; },
  };
}
