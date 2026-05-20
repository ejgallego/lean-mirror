import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createDocumentSnapshot,
  createEditorPlatformShellView,
  EditorPlatformStore,
  EditorServiceRuntime,
  documentTitleFromUri,
  renderEditorPlatformStatusPanel,
  serviceEventFromConnectionStatus,
  type DocumentSyncState,
  type EditorDiagnostic,
  type EditorServiceDescriptor,
  type EditorPlatformShellView,
  inferLanguageIdFromUri,
  type ServiceEvent,
} from "@leanprover/editor-platform";

const hostService: EditorServiceDescriptor = {
  id: "demo-host",
  kind: "demo-host",
  label: "Demo",
};

export interface DemoUi {
  editorHost: HTMLDivElement;
  infoviewHost: HTMLDivElement;
  logEvent(text: string): void;
  platformStore: EditorPlatformStore;
  renderDocumentButtons(
    documents: readonly string[],
    openDocument: (uri: string) => Promise<void>,
  ): void;
  setActiveDocument(uri: string): void;
  setCurrentDocument(uri: string, languageId?: string): void;
  setDocumentDiagnostics(uri: string, diagnostics: readonly EditorDiagnostic[]): void;
  setDocumentSyncState(uri: string, syncState: DocumentSyncState, lastError?: string): void;
  setRootUri(uri: string): void;
  setStatus(text: string): void;
}

export function demoTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "15px",
      backgroundColor: "#fffdf7",
    },
    ".cm-scroller": {
      fontFamily: "\"Iosevka Term\", \"IBM Plex Mono\", monospace",
      lineHeight: "1.5",
    },
    ".cm-content": {
      padding: "16px 0",
    },
    ".cm-gutters": {
      backgroundColor: "#f6f0df",
      color: "#6f6242",
      borderRight: "1px solid #e3d9c2",
    },
    ".cm-activeLine": {
      backgroundColor: "#fff5d9",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#f1e3b5",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "#d7e8ff",
    },
  });
}

function hostEventFromText(text: string): ServiceEvent {
  if (text === "Ready") {
    return serviceEventFromConnectionStatus(hostService.id, { phase: "ready", message: text });
  }
  if (text === "Reconnecting") {
    return serviceEventFromConnectionStatus(hostService.id, { phase: "stale", message: text });
  }
  return serviceEventFromConnectionStatus(hostService.id, { phase: "connecting", message: text });
}

export function queryDemoUi(
  root: ParentNode = document,
  platformStore = new EditorPlatformStore(),
): DemoUi | null {
  const statusPanelEl = root.querySelector<HTMLDivElement>("#status-panel");
  const eventsEl = root.querySelector<HTMLDivElement>("#events");
  const editorHost = root.querySelector<HTMLDivElement>("#editor");
  const infoviewHost = root.querySelector<HTMLDivElement>("#lean-infoview");
  const documentsEl = root.querySelector<HTMLDivElement>("#documents");

  if (
    !statusPanelEl ||
    !eventsEl ||
    !editorHost ||
    !infoviewHost ||
    !documentsEl
  ) {
    return null;
  }

  let rootUri = "Loading";
  let currentShellView: EditorPlatformShellView | null = null;
  const renderStatusPanel = () => {
    if (!currentShellView) {
      return;
    }
    renderEditorPlatformStatusPanel(statusPanelEl, currentShellView, { workspaceUri: rootUri });
  };

  platformStore.subscribe((snapshot) => {
    currentShellView = createEditorPlatformShellView(snapshot, { hostServiceId: hostService.id });
    renderStatusPanel();
  }, { emitCurrent: true });
  const hostRuntime = new EditorServiceRuntime(platformStore, hostService);

  return {
    editorHost,
    infoviewHost,
    platformStore,
    logEvent(text: string) {
      const item = document.createElement("div");
      item.className = "event";
      item.textContent = text;
      eventsEl.prepend(item);
      platformStore.appendLog({
        level: "info",
        message: text,
        timestamp: Date.now(),
      });
    },
    renderDocumentButtons(documents, openDocument) {
      documentsEl.replaceChildren();
      for (const uri of documents) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.uri = uri;
        button.textContent = documentTitleFromUri(uri);
        button.addEventListener("click", () => {
          void openDocument(uri);
        });
        documentsEl.append(button);
      }
    },
    setActiveDocument(uri: string) {
      for (const button of documentsEl.querySelectorAll<HTMLButtonElement>("button")) {
        button.dataset.active = String(button.dataset.uri === uri);
      }
      platformStore.setActiveDocument(uri);
    },
    setCurrentDocument(uri: string, languageId = inferLanguageIdFromUri(uri, { fallback: "lean4" })) {
      const existing = platformStore.snapshot.documents[uri];
      platformStore.setDocument(createDocumentSnapshot({
        uri,
        languageId,
        previous: existing,
        openState: "open",
        syncState: existing?.syncState ?? "clean",
        ...(existing?.lastError ? { lastError: existing.lastError } : {})
      }));
      platformStore.setActiveDocument(uri);
    },
    setDocumentDiagnostics(uri: string, diagnostics: readonly EditorDiagnostic[]) {
      platformStore.setDocumentDiagnostics(uri, diagnostics);
    },
    setDocumentSyncState(uri: string, syncState: DocumentSyncState, lastError?: string) {
      const existing = platformStore.snapshot.documents[uri];
      platformStore.setDocument(createDocumentSnapshot({
        uri,
        languageId: existing?.languageId ?? inferLanguageIdFromUri(uri, { fallback: "lean4" }),
        previous: existing,
        syncState,
        ...(lastError ? { lastError } : {})
      }));
    },
    setRootUri(uri: string) {
      rootUri = uri;
      renderStatusPanel();
    },
    setStatus(text: string) {
      hostRuntime.record(hostEventFromText(text));
    },
  };
}
