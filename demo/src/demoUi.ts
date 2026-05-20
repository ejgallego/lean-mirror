import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createDocumentSnapshot,
  createEditorPlatformShellView,
  EditorPlatformStore,
  EditorServiceRuntime,
  documentTitleFromUri,
  renderEditorPlatformLogPanel,
  renderEditorPlatformStatusPanel,
  renderEditorPlatformWorkspaceShell,
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

const demoWorkspaceShellClassNames = {
  shell: "shell",
  header: "hero",
  eyebrow: "eyebrow",
  layout: "layout",
  sideRail: "side-rail",
  panel: "panel",
  panelHead: "panel-head",
  editorPanel: "panel-editor",
  editorHost: "editor-host",
  statusPanel: "status-card",
  infoPanel: "panel-infoview",
  infoHost: "infoview-host",
  secondaryPanel: "panel-help",
  secondaryHost: "help-host",
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

export function createDemoUi(
  container: HTMLElement,
  platformStore = new EditorPlatformStore(),
): DemoUi {
  renderEditorPlatformWorkspaceShell(container, {
    classNames: demoWorkspaceShellClassNames,
    eyebrow: "Lean 4 + CodeMirror 6",
    ids: {
      info: "lean-infoview",
    },
    labels: {
      editorDescription:
        "Try hover, completion, go-to-definition, rename, formatting, diagnostics, embedded Rust blocks, and embedded Lean snippets in the Rust driver.",
      infoAriaLabel: "Lean InfoView",
      infoTitle: "InfoView",
      secondaryTitle: "Help",
    },
  });

  const helpHost = container.querySelector<HTMLElement>("[data-platform-shell-slot='secondary']");
  if (!helpHost) {
    throw new Error("Demo shell is missing the secondary host slot.");
  }
  renderDemoHelp(helpHost);

  const ui = queryDemoUi(container, platformStore);
  if (!ui) {
    throw new Error("Demo shell is incomplete.");
  }
  return ui;
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
    renderEditorPlatformLogPanel(eventsEl, snapshot.logs, { levels: ["info", "warn", "error"] });
  }, { emitCurrent: true });
  const hostRuntime = new EditorServiceRuntime(platformStore, hostService);

  return {
    editorHost,
    infoviewHost,
    platformStore,
    logEvent(text: string) {
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

function renderDemoHelp(host: HTMLElement): void {
  const ownerDocument = host.ownerDocument;
  const documentsEl = ownerDocument.createElement("div");
  documentsEl.id = "documents";
  documentsEl.className = "documents";

  const helpList = ownerDocument.createElement("ul");
  helpList.className = "help-list";
  appendHelpItem(
    helpList,
    "Hover over ",
    helpCode(ownerDocument, "Nat.succ"),
    " or trigger completion with ",
    helpCode(ownerDocument, "Ctrl-Space"),
    ".",
  );
  appendHelpItem(
    helpList,
    "Use ",
    helpCode(ownerDocument, "F12"),
    " for definition and ",
    helpCode(ownerDocument, "Shift-F12"),
    " for references.",
  );
  appendHelpItem(
    helpList,
    "Rename is on ",
    helpCode(ownerDocument, "F2"),
    ". Formatting is on ",
    helpCode(ownerDocument, "Shift-Alt-F"),
    ". Undo is on ",
    helpCode(ownerDocument, "Ctrl-Z"),
    ".",
  );
  appendHelpItem(helpList, "Each embedded Rust block has its own small inline enable/disable button.");
  appendHelpItem(
    helpList,
    "Open ",
    helpCode(ownerDocument, "Main.rs"),
    " to edit Rust comments that contain Lean snippets.",
  );
  appendHelpItem(helpList, "Edit the file to force diagnostics or signature help.");

  const eventsEl = ownerDocument.createElement("div");
  eventsEl.id = "events";
  eventsEl.className = "events";

  host.replaceChildren(documentsEl, helpList, eventsEl);
}

function appendHelpItem(list: HTMLUListElement, ...parts: Array<HTMLElement | string>): void {
  const item = list.ownerDocument.createElement("li");
  item.append(...parts);
  list.append(item);
}

function helpCode(ownerDocument: Document, text: string): HTMLElement {
  const element = ownerDocument.createElement("code");
  element.textContent = text;
  return element;
}
