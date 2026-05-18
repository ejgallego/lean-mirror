import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createDocumentSnapshot,
  EditorPlatformStore,
  EditorServiceRuntime,
  createEditorPlatformShellView,
  documentTitleFromUri,
  type DocumentSyncState,
  type EditorDiagnostic,
  type EditorServiceDescriptor,
  type EditorServiceStatusView,
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
    return { type: "ready", serviceId: hostService.id, message: text };
  }
  if (text === "Reconnecting") {
    return { type: "stale", serviceId: hostService.id, reason: text };
  }
  return { type: "starting", serviceId: hostService.id, message: text };
}

function renderServiceStatuses(
  servicesEl: HTMLDivElement,
  services: readonly EditorServiceStatusView[],
): void {
  servicesEl.replaceChildren();
  if (services.length === 0) {
    servicesEl.textContent = "Starting";
    return;
  }

  for (const service of services) {
    const row = document.createElement("div");
    row.className = "service-status";
    row.dataset.state = service.lightState;

    const light = document.createElement("span");
    light.className = "service-light";
    light.setAttribute("aria-hidden", "true");

    const label = document.createElement("strong");
    label.textContent = service.label;

    const status = document.createElement("code");
    status.textContent = service.statusLabel;

    row.append(light, label, status);
    servicesEl.append(row);
  }
}

export function queryDemoUi(
  root: ParentNode = document,
  platformStore = new EditorPlatformStore(),
): DemoUi | null {
  const statusEl = root.querySelector<HTMLSpanElement>("#status");
  const servicesEl = root.querySelector<HTMLDivElement>("#service-statuses");
  const diagnosticsEl = root.querySelector<HTMLElement>("#diagnostics-summary");
  const rootUriEl = root.querySelector<HTMLElement>("#root-uri");
  const documentUriEl = root.querySelector<HTMLElement>("#document-uri");
  const eventsEl = root.querySelector<HTMLDivElement>("#events");
  const editorHost = root.querySelector<HTMLDivElement>("#editor");
  const documentsEl = root.querySelector<HTMLDivElement>("#documents");

  if (
    !statusEl ||
    !servicesEl ||
    !diagnosticsEl ||
    !rootUriEl ||
    !documentUriEl ||
    !eventsEl ||
    !editorHost ||
    !documentsEl
  ) {
    return null;
  }

  platformStore.subscribe((snapshot) => {
    const shellView = createEditorPlatformShellView(snapshot, { hostServiceId: hostService.id });
    statusEl.textContent = shellView.statusText;
    diagnosticsEl.textContent = shellView.diagnosticsText;
    renderServiceStatuses(servicesEl, shellView.services);
    if (shellView.activeDocumentUri) {
      documentUriEl.textContent = shellView.activeDocumentUri;
    }
  }, { emitCurrent: true });
  const hostRuntime = new EditorServiceRuntime(platformStore, hostService);

  return {
    editorHost,
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
      rootUriEl.textContent = uri;
    },
    setStatus(text: string) {
      hostRuntime.record(hostEventFromText(text));
    },
  };
}
