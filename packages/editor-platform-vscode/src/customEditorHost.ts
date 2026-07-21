import {
  EditorPlatformStore,
  createHostEndpoint,
  createOnDidReceiveMessageSource,
  createPostMessageTarget,
  platformMessage,
  publishPlatformSnapshots,
  type DisposableLike,
  type DocumentSnapshot,
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
  const documentVersions = new Map<string, number>();
  let disposed = false;

  const dispatch = (message: EditorToHostMessage): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    return handleEditorMessage(options, message, documentVersions);
  };

  const reportFailure = (error: unknown, message: EditorToHostMessage): void => {
    options.onHandlerError?.(error, message);
  };

  subscriptions.push(
    endpoint.subscribe((message) => {
      const queueKey = editorMessageQueueKey(message);
      if (!queueKey) {
        void dispatch(message).catch((error: unknown) => reportFailure(error, message));
        return;
      }

      const previous = messageQueues.get(queueKey);
      const task = previous
        ? previous.catch(() => undefined).then(() => dispatch(message))
        : dispatch(message);
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
  return uri.toString(true);
}

async function handleEditorMessage(
  options: EditorPlatformCustomEditorHostOptions,
  message: EditorToHostMessage,
  documentVersions: Map<string, number>
): Promise<void> {
  switch (message.type) {
    case "ready":
      await options.handlers?.ready?.();
      return;
    case "open-document":
      await options.handlers?.openDocument?.({ uri: message.payload.uri });
      return;
    case "document-changed":
      if (
        message.payload.version !== undefined &&
        message.payload.version <= (documentVersions.get(message.payload.uri) ?? -1)
      ) {
        return;
      }
      await options.handlers?.documentChanged?.({
        uri: message.payload.uri,
        text: message.payload.text,
        ...(message.payload.version === undefined ? {} : { version: message.payload.version })
      });
      if (message.payload.version !== undefined) {
        documentVersions.set(message.payload.uri, message.payload.version);
      }
      return;
    case "restart-service":
      await options.handlers?.restartService?.({
        serviceId: message.payload.serviceId,
        ...(message.payload.reason === undefined ? {} : { reason: message.payload.reason })
      });
      return;
    case "set-active-document":
      options.store.setActiveDocument(message.payload.uri);
      await options.handlers?.setActiveDocument?.({
        uri: message.payload.uri,
        ...(message.payload.languageId === undefined ? {} : { languageId: message.payload.languageId })
      });
      return;
  }
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
