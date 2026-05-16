import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  EditorPlatformStore,
  serviceStatusLabel,
  summarizeDiagnostics,
  type DocumentSyncState,
  type EditorDiagnostic,
  type EditorPlatformSnapshot,
  type EditorServiceDescriptor,
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
  recordServiceEvent(service: EditorServiceDescriptor, event: ServiceEvent): void;
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

function inferLanguageId(uri: string): string {
  if (uri.endsWith(".rs")) {
    return "rust";
  }
  return "lean4";
}

function documentTitle(uri: string): string {
  return uri.split("/").at(-1) ?? uri;
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

function overallStatus(snapshot: EditorPlatformSnapshot): string {
  const host = snapshot.services[hostService.id];
  if (host && host.status.state !== "ready") {
    return serviceStatusLabel(host.status);
  }

  const services = Object.values(snapshot.services).filter((service) => service.id !== hostService.id);
  const failed = services.find((service) => service.status.state === "failed");
  if (failed) {
    return `${failed.label}: ${serviceStatusLabel(failed.status)}`;
  }
  const pending = services.find((service) =>
    service.status.state === "starting" ||
    service.status.state === "initializing" ||
    service.status.state === "stopping"
  );
  if (pending) {
    return `${pending.label}: ${serviceStatusLabel(pending.status)}`;
  }
  const stale = services.find((service) => service.status.state === "stale");
  if (stale) {
    return `${stale.label}: ${serviceStatusLabel(stale.status)}`;
  }
  return host ? serviceStatusLabel(host.status) : "Booting";
}

function diagnosticsText(diagnostics: readonly EditorDiagnostic[]): string {
  const summary = summarizeDiagnostics(diagnostics);
  const parts = [
    `${summary.errors} error${summary.errors === 1 ? "" : "s"}`,
    `${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`,
  ];
  if (summary.infos > 0) {
    parts.push(`${summary.infos} info`);
  }
  if (summary.hints > 0) {
    parts.push(`${summary.hints} hint${summary.hints === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function renderServiceStatuses(
  servicesEl: HTMLDivElement,
  snapshot: EditorPlatformSnapshot,
): void {
  const services = Object.values(snapshot.services).filter((service) => service.id !== hostService.id);
  servicesEl.replaceChildren();
  if (services.length === 0) {
    servicesEl.textContent = "Starting";
    return;
  }

  for (const service of services) {
    const row = document.createElement("div");
    row.className = "service-status";
    row.dataset.state = service.status.state;

    const label = document.createElement("strong");
    label.textContent = service.label;

    const status = document.createElement("code");
    status.textContent = serviceStatusLabel(service.status);

    row.append(label, status);
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
    statusEl.textContent = overallStatus(snapshot);
    diagnosticsEl.textContent = diagnosticsText(snapshot.diagnostics);
    renderServiceStatuses(servicesEl, snapshot);
    if (snapshot.activeDocumentUri) {
      documentUriEl.textContent = snapshot.activeDocumentUri;
    }
  }, { emitCurrent: true });

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
    recordServiceEvent(service: EditorServiceDescriptor, event: ServiceEvent) {
      platformStore.recordServiceEvent(service, event);
    },
    renderDocumentButtons(documents, openDocument) {
      documentsEl.replaceChildren();
      for (const uri of documents) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.uri = uri;
        button.textContent = uri.split("/").at(-1) ?? uri;
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
    setCurrentDocument(uri: string, languageId = inferLanguageId(uri)) {
      const existing = platformStore.snapshot.documents[uri];
      platformStore.setDocument({
        uri,
        languageId,
        version: existing?.version ?? 0,
        openState: "open",
        syncState: existing?.syncState ?? "clean",
        title: existing?.title ?? documentTitle(uri),
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      });
      platformStore.setActiveDocument(uri);
    },
    setDocumentDiagnostics(uri: string, diagnostics: readonly EditorDiagnostic[]) {
      platformStore.setDocumentDiagnostics(uri, diagnostics);
    },
    setDocumentSyncState(uri: string, syncState: DocumentSyncState, lastError?: string) {
      const existing = platformStore.snapshot.documents[uri];
      platformStore.setDocument({
        uri,
        languageId: existing?.languageId ?? inferLanguageId(uri),
        version: existing?.version ?? 0,
        openState: existing?.openState ?? "open",
        syncState,
        title: existing?.title ?? documentTitle(uri),
        ...(lastError ? { lastError } : {}),
      });
    },
    setRootUri(uri: string) {
      rootUriEl.textContent = uri;
    },
    setStatus(text: string) {
      platformStore.recordServiceEvent(hostService, hostEventFromText(text));
    },
  };
}
