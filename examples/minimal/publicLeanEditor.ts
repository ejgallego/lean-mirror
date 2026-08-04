import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanFallbackHighlightStyle,
  waitForWebSocketOpen,
  type LeanEditorSession,
  type LeanEditorSessionState,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import "codemirror-lean4-lsp/infoview.css";
import type * as lsp from "vscode-languageserver-protocol";

export interface LeanEditorDocument {
  languageId: string;
  source: string;
  uri: string;
}

export interface MountLeanEditorOptions {
  document: LeanEditorDocument;
  editorContainer: HTMLElement;
  infoviewContainer: HTMLElement;
  loadDocument?(uri: string): Promise<string | null>;
  onDiagnostics?(params: lsp.PublishDiagnosticsParams): void;
  onDocumentChange?(source: string, version: number): void;
  onError?(error: unknown): void;
  onReconnectStart?(reason: string): void;
  onSessionState?(state: LeanEditorSessionState): void;
  requestTimeoutMs?: number;
  rootUri: string;
  sanitizeHTML?(html: string): string;
  websocketUrl: string;
}

export interface MountedLeanEditor {
  readonly session: LeanEditorSession;
  readonly view: EditorView;
  dispose(): void;
  reconnect(reason?: string): Promise<void>;
}

export async function mountLeanEditor(
  options: MountLeanEditorOptions,
): Promise<MountedLeanEditor> {
  const { document: leanDocument } = options;
  let disposed = false;
  let documentVersion = 0;
  let editorView: EditorView | null = null;
  let infoview: LeanInfoviewHost | null = null;
  let reconnecting: Promise<void> | null = null;

  const workspaceFactory = createLeanWorkspace({
    async displayDocument(uri) {
      return uri === leanDocument.uri ? editorView : null;
    },
    async loadDocument(uri) {
      if (uri === leanDocument.uri) {
        return { doc: leanDocument.source };
      }
      const source = await options.loadDocument?.(uri);
      return source == null ? null : { doc: source };
    },
  });
  const session = createLeanEditorSession({
    client: {
      extensions: [leanInfoviewClientNotifications(() => infoview)],
      features: {
        semanticTokens: true,
      },
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          infoview?.forwardServerNotification("textDocument/publishDiagnostics", params);
          options.onDiagnostics?.(params);
          return false;
        },
      },
      rootUri: options.rootUri,
      ...(options.sanitizeHTML ? { sanitizeHTML: options.sanitizeHTML } : {}),
      timeout: options.requestTimeoutMs ?? 20_000,
      unhandledNotification(_client, method, params) {
        infoview?.forwardServerNotification(method, params);
      },
      workspace: workspaceFactory,
    },
  });
  const unsubscribeSession = session.subscribe((state) => {
    options.onSessionState?.(state);
  }, { emitCurrent: true });

  async function connect(reconnect: boolean): Promise<void> {
    const socket = new WebSocket(options.websocketUrl);
    try {
      await waitForWebSocketOpen(socket);
      if (disposed) {
        throw new Error("Cannot connect a disposed Lean editor.");
      }
      const connection = reconnect
        ? session.reconnect(createWebSocketTransport(socket), {
            disposeTransport: () => socket.close(),
          })
        : session.connect(createWebSocketTransport(socket), {
            disposeTransport: () => socket.close(),
          });
      await connection.initialized;
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async function reconnect(reason = "User requested reconnection"): Promise<void> {
    if (disposed) {
      throw new Error("Cannot reconnect a disposed Lean editor.");
    }
    if (reconnecting) {
      return reconnecting;
    }
    options.onReconnectStart?.(reason);
    infoview?.serverStopped({ message: "Lean is reconnecting.", reason });
    const task = connect(true).then(() => {
      infoview?.serverRestarted();
      infoview?.updateCursorLocation();
    });
    reconnecting = task;
    try {
      await task;
    } catch (error) {
      options.onError?.(error);
      throw error;
    } finally {
      if (reconnecting === task) {
        reconnecting = null;
      }
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeSession();
    infoview?.dispose();
    editorView?.destroy();
    session.dispose();
  }

  try {
    await connect(false);
    infoview = createLeanInfoviewHost({
      client: () => session.client,
      container: options.infoviewContainer,
      currentLanguageId: () => leanDocument.languageId,
      currentUri: () => leanDocument.uri,
      currentView: () => editorView,
      requestRestart(reason) {
        void reconnect(reason).catch(() => undefined);
      },
      workspace: () =>
        (session.client?.workspace as LeanWorkspace | undefined) ?? null,
    });
    infoview.serverRestarted();

    editorView = new EditorView({
      parent: options.editorContainer,
      state: EditorState.create({
        doc: leanDocument.source,
        extensions: [
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
              return;
            }
            documentVersion += 1;
            options.onDocumentChange?.(update.state.doc.toString(), documentVersion);
          }),
          ...lean4({
            extraExtensions: [infoview.editorExtension()],
            highlightStyle: leanFallbackHighlightStyle,
            session,
            uri: leanDocument.uri,
            utilities: {
              foldGutter: false,
              foldKeymap: false,
              indentWithTab: false,
              lineWrapping: true,
              search: false,
              searchKeymap: false,
            },
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
    });
    infoview.updateCursorLocation();
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    dispose,
    reconnect,
    session,
    view: editorView,
  };
}
