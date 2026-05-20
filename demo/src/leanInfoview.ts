import { EditorSelection, Text } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import {
  defaultInfoviewConfig,
  renderInfoview,
  type EditorApi,
  type InfoviewApi,
  type InfoviewConfig,
  type LeanServerCapabilities,
  type ServerStoppedReason,
  type TextInsertKind,
} from "@leanprover/infoview";
import type * as lsp from "vscode-languageserver-protocol";

import type { LeanWorkspace } from "../../src/index.js";

const keepAlivePeriodMs = 10_000;

export interface LeanInfoviewHost {
  dispose(): void;
  editorExtension(): Extension;
  serverRestarted(result?: lsp.InitializeResult<LeanServerCapabilities>): void;
  serverStopped(reason?: ServerStoppedReason): void;
  forwardClientNotification(method: string, params: unknown): void;
  forwardServerNotification(method: string, params: unknown): void;
  setCursorLocation(location?: lsp.Location): void;
  updateCursorLocation(): void;
}

export interface LeanInfoviewHostOptions {
  client: LSPClient;
  container: HTMLElement;
  currentLanguageId(): string | null;
  currentUri(): string | null;
  currentView(): EditorView | null;
  log(message: string): void;
  requestRestart(reason: string): void;
  workspace(): LeanWorkspace | null;
}

export function createLeanInfoviewHost(options: LeanInfoviewHostOptions): LeanInfoviewHost {
  const serverNotificationSubscriptions = new Map<string, number>();
  const clientNotificationSubscriptions = new Map<string, number>();
  const rpcKeepAliveTimers = new Map<string, number>();
  let config: InfoviewConfig = { ...defaultInfoviewConfig };
  let initialized = false;
  let disposed = false;
  let infoviewApi: InfoviewApi;

  function incrementSubscription(subscriptions: Map<string, number>, method: string): void {
    subscriptions.set(method, (subscriptions.get(method) ?? 0) + 1);
  }

  function decrementSubscription(subscriptions: Map<string, number>, method: string): void {
    const current = subscriptions.get(method);
    if (!current) {
      return;
    }
    if (current === 1) {
      subscriptions.delete(method);
      return;
    }
    subscriptions.set(method, current - 1);
  }

  function subscribed(subscriptions: Map<string, number>, method: string): boolean {
    return (subscriptions.get(method) ?? 0) > 0;
  }

  function currentLeanLocation(): lsp.Location | undefined {
    const languageId = options.currentLanguageId();
    if (languageId !== "lean" && languageId !== "lean4") {
      return undefined;
    }
    const view = options.currentView();
    const uri = options.currentUri();
    if (!view || !uri) {
      return undefined;
    }
    const plugin = LSPPlugin.get(view);
    if (!plugin || plugin.client !== options.client) {
      return undefined;
    }
    const selection = view.state.selection.main;
    return {
      uri,
      range: {
        end: plugin.toPosition(selection.to),
        start: plugin.toPosition(selection.from),
      },
    };
  }

  function offsetFromPosition(doc: Text, position: lsp.Position): number {
    const lineNumber = Math.max(1, Math.min(doc.lines, position.line + 1));
    const line = doc.line(lineNumber);
    return Math.max(line.from, Math.min(line.to, line.from + position.character));
  }

  function rangeChange(doc: Text, edit: lsp.TextEdit): { from: number; insert: string; to: number } {
    return {
      from: offsetFromPosition(doc, edit.range.start),
      insert: edit.newText,
      to: offsetFromPosition(doc, edit.range.end),
    };
  }

  async function displayView(uri: string): Promise<EditorView | null> {
    const workspace = options.workspace();
    if (!workspace) {
      return options.currentUri() === uri ? options.currentView() : null;
    }
    const opened = await workspace.displayFile(uri);
    return opened ?? workspace.getFile(uri)?.getView() ?? null;
  }

  async function applyTextEdits(uri: string, edits: readonly lsp.TextEdit[]): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || edits.length === 0) {
      return;
    }
    const file = await workspace.requestFile(uri);
    if (!file) {
      return;
    }
    const doc = file.getView()?.state.doc ?? file.doc;
    const changes = edits
      .map((edit) => rangeChange(doc, edit))
      .sort((left, right) => left.from - right.from || left.to - right.to);
    workspace.updateFile(uri, { changes });
  }

  async function insertText(
    text: string,
    kind: TextInsertKind,
    position?: lsp.TextDocumentPositionParams,
  ): Promise<void> {
    const uri = position?.textDocument.uri ?? options.currentUri();
    if (!uri) {
      return;
    }
    const view = position ? await displayView(uri) : options.currentView();
    if (view) {
      const offset = position
        ? offsetFromPosition(view.state.doc, position.position)
        : view.state.selection.main.from;
      const line = view.state.doc.lineAt(offset);
      const from = kind === "above" ? line.from : offset;
      const insert = kind === "above" ? `${text}\n` : text;
      view.dispatch({
        changes: { from, insert },
        selection: EditorSelection.cursor(from + insert.length),
        scrollIntoView: true,
      });
      return;
    }

    const workspace = options.workspace();
    const file = workspace ? await workspace.requestFile(uri) : null;
    if (!workspace || !file || !position) {
      return;
    }
    const offset = offsetFromPosition(file.doc, position.position);
    const line = file.doc.lineAt(offset);
    const from = kind === "above" ? line.from : offset;
    workspace.updateFile(uri, {
      changes: {
        from,
        insert: kind === "above" ? `${text}\n` : text,
      },
    });
  }

  async function applyWorkspaceEdit(edit: lsp.WorkspaceEdit): Promise<void> {
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) {
        await applyTextEdits(uri, edits);
      }
    }
    if (edit.documentChanges) {
      for (const documentChange of edit.documentChanges) {
        if ("textDocument" in documentChange && "edits" in documentChange) {
          await applyTextEdits(documentChange.textDocument.uri, documentChange.edits);
        }
      }
    }
  }

  async function showDocument(params: lsp.ShowDocumentParams): Promise<void> {
    const view = await displayView(params.uri);
    if (!view || !params.selection) {
      return;
    }
    const anchor = offsetFromPosition(view.state.doc, params.selection.start);
    const head = offsetFromPosition(view.state.doc, params.selection.end);
    view.dispatch({
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      selection: EditorSelection.range(anchor, head),
    });
    view.focus();
  }

  async function createRpcSession(uri: string): Promise<string> {
    options.client.sync();
    const connected = await options.client.request<{ uri: string }, { sessionId: string | number }>(
      "$/lean/rpc/connect",
      { uri },
    );
    const sessionId = String(connected.sessionId);
    const timer = window.setInterval(() => {
      options.client.notification("$/lean/rpc/keepAlive", { sessionId, uri });
    }, keepAlivePeriodMs);
    rpcKeepAliveTimers.set(sessionId, timer);
    return sessionId;
  }

  function closeRpcSession(sessionId: string): void {
    const timer = rpcKeepAliveTimers.get(sessionId);
    if (timer !== undefined) {
      window.clearInterval(timer);
      rpcKeepAliveTimers.delete(sessionId);
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  }

  const editorApi: EditorApi = {
    async saveConfig(nextConfig) {
      config = { ...nextConfig };
      await infoviewApi.changedInfoviewConfig(config);
    },
    async sendClientRequest(_uri, method, params, requestOptions) {
      options.client.sync();
      const request = options.client.request(method, params);
      const abort = () => {
        options.client.cancelRequest(params);
      };
      requestOptions?.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        return await request;
      } finally {
        requestOptions?.abortSignal?.removeEventListener("abort", abort);
      }
    },
    async sendClientNotification(_uri, method, params) {
      options.client.notification(method, params);
    },
    async subscribeServerNotifications(method) {
      incrementSubscription(serverNotificationSubscriptions, method);
    },
    async unsubscribeServerNotifications(method) {
      decrementSubscription(serverNotificationSubscriptions, method);
    },
    async subscribeClientNotifications(method) {
      incrementSubscription(clientNotificationSubscriptions, method);
    },
    async unsubscribeClientNotifications(method) {
      decrementSubscription(clientNotificationSubscriptions, method);
    },
    copyToClipboard,
    insertText,
    applyEdit: applyWorkspaceEdit,
    showDocument,
    async restartFile(uri) {
      options.requestRestart(`Lean infoview requested file restart for ${uri}`);
    },
    createRpcSession,
    async closeRpcSession(sessionId) {
      closeRpcSession(sessionId);
    },
  };

  infoviewApi = renderInfoview(editorApi, options.container);
  void infoviewApi.changedInfoviewConfig(config);

  function setCursorLocation(location?: lsp.Location): void {
    if (disposed) {
      return;
    }
    if (!initialized && location) {
      initialized = true;
      void infoviewApi.initialize(location);
      return;
    }
    void infoviewApi.changedCursorLocation(location);
  }

  function updateCursorLocation(): void {
    setCursorLocation(currentLeanLocation());
  }

  return {
    dispose() {
      disposed = true;
      for (const sessionId of [...rpcKeepAliveTimers.keys()]) {
        closeRpcSession(sessionId);
      }
      options.container.replaceChildren();
    },
    editorExtension() {
      return EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.selectionSet || update.focusChanged || update.docChanged) {
          updateCursorLocation();
        }
      });
    },
    serverRestarted(initializeResult) {
      const result: lsp.InitializeResult<LeanServerCapabilities> = {
        ...initializeResult,
        capabilities: initializeResult?.capabilities ?? options.client.serverCapabilities ?? {},
        serverInfo: initializeResult?.serverInfo ?? {
          name: "Lean",
          version: "0.0.0",
        },
      };
      void infoviewApi.serverStopped(undefined);
      void infoviewApi.serverRestarted(result);
    },
    serverStopped(reason) {
      void infoviewApi.serverStopped(reason);
    },
    forwardClientNotification(method, params) {
      if (subscribed(clientNotificationSubscriptions, method)) {
        void infoviewApi.sentClientNotification(method, params);
      }
    },
    forwardServerNotification(method, params) {
      if (subscribed(serverNotificationSubscriptions, method)) {
        void infoviewApi.gotServerNotification(method, params);
      }
    },
    setCursorLocation,
    updateCursorLocation,
  };
}

export function forwardLeanClientNotifications(client: LSPClient, host: LeanInfoviewHost): () => void {
  const original = client.notification.bind(client) as LSPClient["notification"];

  client.notification = ((method: string, params: unknown) => {
    original(method, params);
    host.forwardClientNotification(method, params);
  }) as LSPClient["notification"];

  return () => {
    client.notification = original;
  };
}
