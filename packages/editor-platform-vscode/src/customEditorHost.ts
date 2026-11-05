import {
  EditorPlatformStore,
  createHostEndpoint,
  createOnDidReceiveMessageSource,
  createPostMessageTarget,
  platformMessage,
  publishPlatformSnapshots,
  type DisposableLike,
  type DocumentSnapshot,
  type EditorCommandRequestId,
  type EditorCommandResult,
  type EditorCommandType,
  type EditorSessionId,
  type EditorPlatformEndpoint,
  type EditorToHostMessage,
  type HostToEditorMessage,
  type OnDidReceiveMessageLike,
  type PostMessageLike,
  type Unsubscribe
} from "@leanprover/editor-platform";

export interface VsCodeWebviewLike
  extends PostMessageLike<HostToEditorMessage>,
    OnDidReceiveMessageLike {}

export interface VsCodeUriLike {
  scheme?: string;
  fsPath?: string;
  toString(skipEncoding?: boolean): string;
}

export interface VsCodeCustomDocumentLike {
  uri: VsCodeUriLike;
  dispose?(): void;
}

export interface VsCodeWebviewPanelLike {
  webview: VsCodeWebviewLike;
  onDidDispose(listener: () => void): DisposableLike;
}

export interface OpenDocumentRequest {
  uri: string;
}

export interface DocumentChangedRequest {
  uri: string;
  text: string;
  version?: number;
}

export interface RestartServiceRequest {
  serviceId: string;
  reason?: string;
}

export interface SetActiveDocumentRequest {
  uri: string;
  languageId?: string;
}

export interface EditorPlatformCustomEditorHostHandlers {
  ready?(): void | Promise<void>;
  openDocument?(request: OpenDocumentRequest): void | Promise<void>;
  documentChanged?(request: DocumentChangedRequest): void | Promise<void>;
  restartService?(request: RestartServiceRequest): void | Promise<void>;
  setActiveDocument?(request: SetActiveDocumentRequest): void | Promise<void>;
}

export interface EditorPlatformCustomEditorHostOptions {
  store: EditorPlatformStore;
  webview: VsCodeWebviewLike;
  handlers?: EditorPlatformCustomEditorHostHandlers;
  publishSnapshots?: boolean;
  emitCurrentSnapshot?: boolean;
  onInvalidMessage?: (message: unknown) => void;
  /** A valid command from a webview session other than the current one; it is dropped. */
  onStaleMessage?: (message: EditorToHostMessage) => void;
  onHandlerError?: (error: unknown, message: EditorToHostMessage) => void;
}

export interface EditorPlatformCustomEditorHost {
  readonly endpoint: EditorPlatformEndpoint<EditorToHostMessage, HostToEditorMessage>;
  postMessage(message: HostToEditorMessage): void;
  dispose(): void;
}

export function createEditorPlatformCustomEditorHost(
  options: EditorPlatformCustomEditorHostOptions
): EditorPlatformCustomEditorHost {
  const endpoint = createHostEndpoint(
    createPostMessageTarget(options.webview),
    createOnDidReceiveMessageSource(options.webview),
    {
      ...(options.onInvalidMessage ? { onInvalidMessage: options.onInvalidMessage } : {})
    }
  );
  const subscriptions: Unsubscribe[] = [];
  const messageQueues = new Map<string, Promise<void>>();
  const documentVersions: DocumentVersionState = { epoch: 0, session: undefined, versions: new Map() };
  let disposed = false;

  // A webview generation owns its queued commands and their replies. Work queued
  // by an earlier generation never runs or replies after a later `ready`.
  const isCurrent = (epoch: number): boolean => !disposed && epoch === documentVersions.epoch;
  const dispatch = (message: EditorToHostMessage, epoch: number): Promise<void> => {
    if (!isCurrent(epoch)) {
      return Promise.resolve();
    }
    return dispatchEditorMessage(options, endpoint, message, documentVersions, epoch, () => isCurrent(epoch));
  };

  const reportFailure = (error: unknown, message: EditorToHostMessage): void => {
    options.onHandlerError?.(error, message);
  };

  subscriptions.push(
    endpoint.subscribe((message) => {
      if (message.type === "ready") {
        // A reloaded webview restarts its document version counters. Without a
        // session, `ready` is a receive-order barrier: it owns everything
        // received after it. With one, only commands carrying it are accepted.
        documentVersions.epoch += 1;
        documentVersions.session = message.payload.session;
        documentVersions.versions.clear();
      } else if (
        documentVersions.session !== undefined &&
        message.payload.session !== documentVersions.session
      ) {
        // Sent by another webview instance, possibly arriving after a newer ready.
        options.onStaleMessage?.(message);
        return;
      }
      const epoch = documentVersions.epoch;
      const queueKey = editorMessageQueueKey(message);
      if (!queueKey) {
        void dispatch(message, epoch).catch((error: unknown) => reportFailure(error, message));
        return;
      }

      const previous = messageQueues.get(queueKey);
      const task = previous
        ? previous.catch(() => undefined).then(() => dispatch(message, epoch))
        : dispatch(message, epoch);
      messageQueues.set(queueKey, task);
      void task
        .catch((error: unknown) => reportFailure(error, message))
        .finally(() => {
          if (messageQueues.get(queueKey) === task) {
            messageQueues.delete(queueKey);
          }
        });
    })
  );

  if (options.publishSnapshots ?? true) {
    subscriptions.push(
      publishPlatformSnapshots(options.store, endpoint, {
        emitCurrent: options.emitCurrentSnapshot ?? true
      })
    );
  }

  return {
    endpoint,
    postMessage(message) {
      endpoint.postMessage(message);
    },
    dispose() {
      disposed = true;
      messageQueues.clear();
      for (const unsubscribe of subscriptions.splice(0)) {
        unsubscribe();
      }
      endpoint.dispose();
    }
  };
}

export function attachEditorPlatformHostToPanel(
  panel: VsCodeWebviewPanelLike,
  options: Omit<EditorPlatformCustomEditorHostOptions, "webview">
): EditorPlatformCustomEditorHost {
  const host = createEditorPlatformCustomEditorHost({
    ...options,
    webview: panel.webview
  });
  const panelDisposable = panel.onDidDispose(() => {
    host.dispose();
  });
  const disposeHost = host.dispose;

  return {
    endpoint: host.endpoint,
    postMessage(message) {
      host.postMessage(message);
    },
    dispose() {
      panelDisposable.dispose();
      disposeHost();
    }
  };
}

export function documentOpenedMessage(
  document: VsCodeCustomDocumentLike,
  options: { languageId: string; version?: number; text?: string; title?: string }
): HostToEditorMessage {
  const snapshot: DocumentSnapshot = {
    uri: vscodeUriToString(document.uri),
    languageId: options.languageId,
    version: options.version ?? 0,
    openState: "open",
    syncState: "clean",
    ...(options.title === undefined ? {} : { title: options.title })
  };

  return platformMessage("document-opened", {
    document: snapshot,
    ...(options.text === undefined ? {} : { text: options.text })
  });
}

export function vscodeUriToString(uri: VsCodeUriLike): string {
  return uri.toString();
}

interface DocumentVersionState {
  /** Incremented on each webview `ready`; work received before it is retired. */
  epoch: number;
  /** The session declared by the current webview's `ready`, if any. */
  session: EditorSessionId | undefined;
  readonly versions: Map<string, number>;
}

async function handleEditorMessage(
  options: EditorPlatformCustomEditorHostOptions,
  message: EditorToHostMessage,
  documentVersions: DocumentVersionState,
  epoch: number
): Promise<boolean> {
  switch (message.type) {
    case "ready":
      if (!options.handlers?.ready) return false;
      await options.handlers.ready();
      return true;
    case "open-document":
      if (!options.handlers?.openDocument) return false;
      await options.handlers.openDocument({ uri: message.payload.uri });
      return true;
    case "document-changed":
      if (
        message.payload.version !== undefined &&
        message.payload.version <= (documentVersions.versions.get(message.payload.uri) ?? -1)
      ) {
        return false;
      }
      if (!options.handlers?.documentChanged) return false;
      await options.handlers.documentChanged({
        uri: message.payload.uri,
        text: message.payload.text,
        ...(message.payload.version === undefined ? {} : { version: message.payload.version })
      });
      if (message.payload.version !== undefined && epoch === documentVersions.epoch) {
        documentVersions.versions.set(message.payload.uri, message.payload.version);
      }
      return true;
    case "restart-service":
      if (!options.handlers?.restartService) return false;
      await options.handlers.restartService({
        serviceId: message.payload.serviceId,
        ...(message.payload.reason === undefined ? {} : { reason: message.payload.reason })
      });
      return true;
    case "set-active-document":
      options.store.setActiveDocument(message.payload.uri);
      await options.handlers?.setActiveDocument?.({
        uri: message.payload.uri,
        ...(message.payload.languageId === undefined ? {} : { languageId: message.payload.languageId })
      });
      return true;
  }
}

async function dispatchEditorMessage(
  options: EditorPlatformCustomEditorHostOptions,
  endpoint: EditorPlatformEndpoint<EditorToHostMessage, HostToEditorMessage>,
  message: EditorToHostMessage,
  documentVersions: DocumentVersionState,
  epoch: number,
  isCurrent: () => boolean
): Promise<void> {
  const command = editorCommandRequest(message);
  try {
    const handled = await handleEditorMessage(options, message, documentVersions, epoch);
    if (command && isCurrent()) {
      endpoint.postMessage(platformMessage("command-result", {
        command: command.type,
        handled,
        ok: true,
        requestId: command.requestId,
        ...(command.session === undefined ? {} : { session: command.session })
      } satisfies EditorCommandResult));
    }
  } catch (error) {
    if (command && isCurrent()) {
      endpoint.postMessage(platformMessage("command-result", {
        command: command.type,
        message: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: command.requestId,
        ...(command.session === undefined ? {} : { session: command.session })
      } satisfies EditorCommandResult));
    }
    throw error;
  }
}

function editorCommandRequest(
  message: EditorToHostMessage
): { requestId: EditorCommandRequestId; session?: EditorSessionId; type: EditorCommandType } | undefined {
  if (message.type === "ready" || message.payload.requestId === undefined) {
    return undefined;
  }
  return {
    requestId: message.payload.requestId,
    type: message.type,
    ...(message.payload.session === undefined ? {} : { session: message.payload.session })
  };
}

function editorMessageQueueKey(message: EditorToHostMessage): string | undefined {
  switch (message.type) {
    case "open-document":
    case "document-changed":
    case "set-active-document":
      return `document:${message.payload.uri}`;
    case "ready":
    case "restart-service":
      return undefined;
  }
}
