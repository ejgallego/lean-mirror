import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  createDocumentSnapshot,
  createEditorPlatformShellView,
  EditorPlatformStore,
  EditorServiceRuntime,
  renderEditorPlatformLogPanel,
  renderEditorPlatformStatusPanel,
  renderEditorPlatformWorkspaceShell,
  type DiagnosticSeverity,
  type EditorDiagnostic,
} from "@leanprover/editor-platform";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  leanFallbackHighlightStyle,
  waitForWebSocketOpen,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import "codemirror-lean4-lsp/infoview.css";
import type * as lsp from "vscode-languageserver-protocol";

import "./style.css";

interface BackendSession {
  documentLanguageIds?: Record<string, string>;
  documents: string[];
  rootUri: string;
  websocketUrl: string;
}

const backendUrl = import.meta.env.VITE_LEAN_BACKEND_URL ?? "http://127.0.0.1:7457";
const leanService = {
  id: "lean-lsp",
  kind: "lean-lsp",
  label: "Lean",
} as const;

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const app = document.querySelector<HTMLElement>("#app");
  if (app) {
    app.innerHTML = `<section class="fatal-error"><h1>Lean editor failed to start</h1><pre></pre></section>`;
    const details = app.querySelector("pre");
    if (details) {
      details.textContent = message;
    }
  }
  console.error(error);
});

async function start(): Promise<void> {
  const app = requiredElement<HTMLElement>("#app");
  const backendSession = await fetchBackendSession();
  const documentUri = selectLeanDocument(backendSession.documents);
  const initialSource = await fetchDocument(documentUri);
  const languageId = backendSession.documentLanguageIds?.[documentUri] ?? "lean4";

  const platformStore = new EditorPlatformStore();
  const leanRuntime = new EditorServiceRuntime(platformStore, leanService);
  const shell = renderEditorPlatformWorkspaceShell(app, {
    eyebrow: "Minimal public-API experiment",
    ids: {
      editor: "minimal-editor",
      info: "lean-infoview",
      status: "minimal-status",
    },
    labels: {
      editorDescription: "One Lean document with session-safe reconnection.",
      editorTitle: "Lean Editor",
      infoAriaLabel: "Lean infoview",
      infoTitle: "Lean Infoview",
      secondaryAriaLabel: "Lean service events",
      secondaryTitle: "Events",
    },
  });
  const editorHost = shell.editorHost as HTMLElement;
  const infoviewHost = shell.infoHost as HTMLElement;
  const eventHost = shell.secondaryHost as HTMLElement;
  const controls = document.createElement("div");
  controls.className = "minimal-controls";
  const generation = document.createElement("span");
  generation.id = "lean-generation";
  generation.textContent = "Generation 0";
  const restartButton = document.createElement("button");
  restartButton.id = "restart-lean";
  restartButton.type = "button";
  restartButton.textContent = "Reconnect Lean";
  controls.append(generation, restartButton);
  const editorMount = document.createElement("div");
  editorMount.className = "minimal-editor-mount";
  editorHost.append(controls, editorMount);

  const renderPlatform = () => {
    const shellView = createEditorPlatformShellView(platformStore.snapshot);
    renderEditorPlatformStatusPanel(shell.statusPanel, shellView, {
      diagnosticsScope: "active-document",
      workspaceUri: backendSession.rootUri,
    });
    renderEditorPlatformLogPanel(eventHost, platformStore.snapshot.logs, {
      emptyText: "No events yet.",
      levels: ["info", "warn", "error"],
      maxEntries: 8,
    });
  };
  const unsubscribePlatform = platformStore.subscribe(renderPlatform, { emitCurrent: true });
  platformStore.setDocument(createDocumentSnapshot({
    languageId,
    openState: "open",
    syncState: "clean",
    uri: documentUri,
    version: 0,
  }));
  platformStore.setActiveDocument(documentUri);

  let infoview: LeanInfoviewHost | null = null;
  let editorView: EditorView | null = null;
  let documentVersion = 0;
  let reconnecting: Promise<void> | null = null;

  const workspaceFactory = createLeanWorkspace({
    async displayDocument(uri) {
      return uri === documentUri ? editorView : null;
    },
    async loadDocument(uri) {
      return {
        doc: uri === documentUri ? initialSource : await fetchDocument(uri),
      };
    },
  });
  const leanSession = createLeanEditorSession({
    client: {
      extensions: [leanInfoviewClientNotifications(() => infoview)],
      features: {
        semanticTokens: true,
      },
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params: lsp.PublishDiagnosticsParams) => {
          infoview?.forwardServerNotification("textDocument/publishDiagnostics", params);
          platformStore.setDocumentDiagnostics(
            params.uri,
            params.diagnostics.map((diagnostic) => platformDiagnostic(params.uri, diagnostic)),
          );
          return false;
        },
      },
      rootUri: backendSession.rootUri,
      unhandledNotification(_client, method, params) {
        infoview?.forwardServerNotification(method, params);
      },
      workspace: workspaceFactory,
    },
  });
  const unsubscribeSession = leanSession.subscribe((state) => {
    generation.textContent = `Generation ${state.generation}`;
    generation.dataset.phase = state.phase;
    switch (state.phase) {
      case "idle":
        leanRuntime.stopped("Disconnected");
        break;
      case "initializing":
        leanRuntime.initializing(`Generation ${state.generation}`);
        break;
      case "ready":
        leanRuntime.ready(`Generation ${state.generation}`);
        break;
      case "failed":
        leanRuntime.failed(errorMessage(state.error), { recoverable: true });
        break;
      case "disposed":
        leanRuntime.stopped("Disposed");
        break;
    }
  }, { emitCurrent: true });

  async function connect(reconnect: boolean): Promise<void> {
    const socket = new WebSocket(backendSession.websocketUrl);
    try {
      await waitForWebSocketOpen(socket);
    } catch (error) {
      socket.close();
      throw error;
    }
    const connection = reconnect
      ? leanSession.reconnect(createWebSocketTransport(socket), {
          disposeTransport: () => socket.close(),
        })
      : leanSession.connect(createWebSocketTransport(socket), {
          disposeTransport: () => socket.close(),
        });
    await connection.initialized;
  }

  await connect(false);
  infoview = createLeanInfoviewHost({
    client: () => leanSession.client,
    container: infoviewHost,
    currentLanguageId: () => languageId,
    currentUri: () => documentUri,
    currentView: () => editorView,
    requestRestart(reason) {
      void reconnect(reason).catch(() => undefined);
    },
    workspace: () =>
      (leanSession.client?.workspace as LeanWorkspace | undefined) ?? null,
  });
  infoview.serverRestarted();

  editorView = new EditorView({
    parent: editorMount,
    state: EditorState.create({
      doc: initialSource,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }
          documentVersion += 1;
          platformStore.setDocument(createDocumentSnapshot({
            languageId,
            openState: "open",
            syncState: "dirty",
            uri: documentUri,
            version: documentVersion,
          }));
        }),
        ...lean4({
          extraExtensions: [infoview.editorExtension()],
          highlightStyle: leanFallbackHighlightStyle,
          session: leanSession,
          uri: documentUri,
          utilities: {
            lineWrapping: true,
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

  async function reconnect(reason = "User requested reconnection"): Promise<void> {
    if (reconnecting) {
      return reconnecting;
    }
    restartButton.disabled = true;
    restartButton.textContent = "Reconnecting…";
    leanRuntime.stale(reason);
    infoview?.serverStopped({ message: "Lean is reconnecting.", reason });
    const task = connect(true).then(() => {
      infoview?.serverRestarted();
      infoview?.updateCursorLocation();
    });
    reconnecting = task;
    try {
      await task;
    } catch (error) {
      if (leanSession.state.phase !== "failed") {
        leanRuntime.failed(errorMessage(error), { recoverable: true });
      }
      throw error;
    } finally {
      if (reconnecting === task) {
        reconnecting = null;
      }
      restartButton.disabled = false;
      restartButton.textContent = "Reconnect Lean";
    }
  }

  restartButton.addEventListener("click", () => {
    void reconnect().catch(() => undefined);
  });

  const dispose = () => {
    unsubscribePlatform();
    unsubscribeSession();
    infoview?.dispose();
    editorView?.destroy();
    leanSession.dispose();
  };
  window.addEventListener("beforeunload", dispose, { once: true });
}

async function fetchBackendSession(): Promise<BackendSession> {
  const response = await fetch(`${backendUrl}/session`);
  if (!response.ok) {
    throw new Error(`Session request failed with ${response.status}.`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new Error("Session response must be an object.");
  }
  const documents = stringArray(value.documents);
  if (
    !documents ||
    typeof value.rootUri !== "string" ||
    typeof value.websocketUrl !== "string"
  ) {
    throw new Error("Session response is missing its Lean workspace fields.");
  }
  const documentLanguageIds = stringRecord(value.documentLanguageIds);
  return {
    ...(documentLanguageIds ? { documentLanguageIds } : {}),
    documents,
    rootUri: value.rootUri,
    websocketUrl: value.websocketUrl,
  };
}

async function fetchDocument(uri: string): Promise<string> {
  const response = await fetch(`${backendUrl}/document?uri=${encodeURIComponent(uri)}`);
  if (!response.ok) {
    throw new Error(`Document request failed with ${response.status}.`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error("Document response must contain text.");
  }
  return value.text;
}

function selectLeanDocument(documents: readonly string[]): string {
  const selected = documents.find((uri) => uri.endsWith("/Helper.lean")) ??
    documents.find((uri) => uri.endsWith(".lean"));
  if (!selected) {
    throw new Error("The backend session did not provide a Lean document.");
  }
  return selected;
}

function platformDiagnostic(uri: string, diagnostic: lsp.Diagnostic): EditorDiagnostic {
  const result: EditorDiagnostic = {
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic.severity),
    uri,
  };
  if (typeof diagnostic.source === "string") {
    result.source = diagnostic.source;
  }
  if (typeof diagnostic.code === "string" || typeof diagnostic.code === "number") {
    result.code = String(diagnostic.code);
  }
  return result;
}

function diagnosticSeverity(severity: lsp.Diagnostic["severity"]): DiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

function requiredElement<ElementType extends HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Missing required element ${selector}.`);
  }
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    return null;
  }
  return value as Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown Lean session failure");
}
