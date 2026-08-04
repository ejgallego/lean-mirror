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

import { applyLeanWorkspaceEdit } from "./workspaceEdit.js";
import type { LeanEditorSessionExtension } from "./session.js";
import type { LeanWorkspace } from "./workspace.js";

const keepAlivePeriodMs = 10_000;

function requestAbortedError(): Error {
  const error = new Error("Lean infoview request aborted.");
  error.name = "AbortError";
  return error;
}

function abortableClientRequest<Params, Result>(
  client: LSPClient,
  method: string,
  params: Params,
  abortSignal?: AbortSignal,
): Promise<Result> {
  if (abortSignal?.aborted) {
    return Promise.reject(requestAbortedError());
  }
  const request = client.request<Params, Result>(method, params);
  if (!abortSignal) {
    return request;
  }
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => {
    client.cancelRequest(params);
    rejectAborted(requestAbortedError());
  };
  abortSignal.addEventListener("abort", abort, { once: true });
  return Promise.race([request, aborted]).finally(() => {
    abortSignal.removeEventListener("abort", abort);
  });
}

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
  client(): LSPClient | null;
  container: HTMLElement;
  currentLanguageId(): string | null;
  currentUri(): string | null;
  currentView(): EditorView | null;
  requestRestart(reason: string): void;
  workspace(): LeanWorkspace | null;
}

export function createLeanInfoviewHost(options: LeanInfoviewHostOptions): LeanInfoviewHost {
  const serverNotificationSubscriptions = new Map<string, number>();
  const clientNotificationSubscriptions = new Map<string, number>();
  const rpcKeepAliveTimers = new Map<string, number>();
  const rpcConnectControllers = new Set<AbortController>();
  let config: InfoviewConfig = { ...defaultInfoviewConfig };
  let initialized = false;
  let disposed = false;
  let infoviewApi: InfoviewApi;

  function currentClient(): LSPClient {
    const client = options.client();
    if (!client) {
      throw new Error("Lean infoview requires an active client generation.");
    }
    return client;
  }

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
    const client = options.client();
    if (!client || !view || !uri) {
      return undefined;
    }
    const plugin = LSPPlugin.get(view);
    if (!plugin || plugin.client !== client) {
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

  async function displayView(uri: string): Promise<EditorView | null> {
    const workspace = options.workspace();
    if (!workspace) {
      return options.currentUri() === uri ? options.currentView() : null;
    }
    const opened = await workspace.displayFile(uri);
    return opened ?? workspace.getFile(uri)?.getView() ?? null;
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
    const result = await applyLeanWorkspaceEdit(currentClient(), edit, {
      userEvent: "lean.infoview",
    });
    if (!result.applied) {
      throw new Error(
        result.failureReason ?? "The Lean infoview workspace edit was rejected.",
      );
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
    const client = currentClient();
    client.sync();
    const controller = new AbortController();
    rpcConnectControllers.add(controller);
    let connected: { sessionId: string | number };
    try {
      connected = await abortableClientRequest(
        client,
        "$/lean/rpc/connect",
        { uri },
        controller.signal,
      );
    } finally {
      rpcConnectControllers.delete(controller);
    }
    const sessionId = String(connected.sessionId);
    const timer = window.setInterval(() => {
      options.client()?.notification("$/lean/rpc/keepAlive", { sessionId, uri });
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

  function closeRpcSessions(): void {
    for (const controller of rpcConnectControllers) {
      controller.abort();
    }
    for (const sessionId of [...rpcKeepAliveTimers.keys()]) {
      closeRpcSession(sessionId);
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
      const client = currentClient();
      client.sync();
      const abortSignal = requestOptions?.abortSignal;
      return abortableClientRequest(client, method, params, abortSignal);
    },
    async sendClientNotification(_uri, method, params) {
      currentClient().notification(method, params);
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
      closeRpcSessions();
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
      closeRpcSessions();
      const client = options.client();
      const result: lsp.InitializeResult<LeanServerCapabilities> = {
        ...initializeResult,
        capabilities: initializeResult?.capabilities ?? client?.serverCapabilities ?? {},
        serverInfo: initializeResult?.serverInfo ?? {
          name: "Lean",
          version: "0.0.0",
        },
      };
      void infoviewApi.serverStopped(undefined);
      void infoviewApi.serverRestarted(result);
    },
    serverStopped(reason) {
      closeRpcSessions();
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

export function leanInfoviewClientNotifications(
  host: () => LeanInfoviewHost | null,
): LeanEditorSessionExtension {
  const activeClients = new WeakSet<LSPClient>();
  return {
    onSessionDisconnect(client) {
      activeClients.delete(client);
    },
    wrapTransport(transport, client) {
      activeClients.add(client);
      return {
        send(message) {
          transport.send(message);
          if (!activeClients.has(client)) {
            return;
          }
          try {
            const parsed = JSON.parse(message) as {
              id?: unknown;
              method?: unknown;
              params?: unknown;
            };
            if (!("id" in parsed) && typeof parsed.method === "string") {
              host()?.forwardClientNotification(parsed.method, parsed.params);
            }
          } catch {
            // Transport payload validation remains the transport's responsibility.
          }
        },
        subscribe(handler) {
          transport.subscribe(handler);
        },
        unsubscribe(handler) {
          transport.unsubscribe(handler);
        },
      };
    },
  };
}
