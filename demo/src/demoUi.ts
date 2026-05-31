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

import type { DemoExample } from "./demoSession.js";

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

export type RegenerationMode = "manual" | "auto";

export interface DemoUi {
  editorHost: HTMLDivElement;
  infoviewHost: HTMLDivElement;
  logEvent(text: string): void;
  platformStore: EditorPlatformStore;
  renderDocumentButtons(
    documents: readonly string[],
    openDocument: (uri: string) => Promise<void>,
  ): void;
  renderExampleButtons(
    examples: readonly DemoExample[],
    activeExampleId: string | undefined,
    switchExample: (example: DemoExample) => Promise<void>,
  ): void;
  setDemoContext(context: {
    activeExampleLabel?: string | undefined;
    project?: string | undefined;
    summary?: string | undefined;
    title?: string | undefined;
  }): void;
  setActiveDocument(uri: string): void;
  setCurrentDocument(uri: string, languageId?: string): void;
  setDocumentDiagnostics(uri: string, diagnostics: readonly EditorDiagnostic[]): void;
  setDocumentSyncState(uri: string, syncState: DocumentSyncState, lastError?: string): void;
  setExtractionState(text: string, tone?: "fresh" | "stale" | "pending"): void;
  setRegenerateAction(action: (() => void) | null): void;
  setRegenerateState(state: { busy?: boolean; enabled: boolean; label?: string; title?: string }): void;
  setRegenerationMode(mode: RegenerationMode, enabled: boolean): void;
  setRegenerationModeAction(action: ((mode: RegenerationMode) => void) | null): void;
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
        "Try hover, completion, go-to-definition, rename, diagnostics, Rust formatting, embedded Rust blocks, and embedded Lean snippets in the Rust driver.",
      infoAriaLabel: "Lean InfoView",
      infoTitle: "InfoView",
      secondaryTitle: "Runtime",
    },
  });

  const header = container.querySelector<HTMLElement>(".hero");
  const projectEl = header?.querySelector<HTMLElement>(".eyebrow");
  if (projectEl) {
    projectEl.id = "demo-project";
  }
  if (header) {
    const titleEl = document.createElement("h1");
    titleEl.id = "demo-title";
    titleEl.textContent = "Embedded Lean over Rust comments";
    const summaryEl = document.createElement("p");
    summaryEl.id = "demo-summary";
    summaryEl.className = "lede";
    summaryEl.textContent =
      "This demo mirrors Lean spec comments embedded in Rust into a hidden Lean file, then checks them through the local Lean LSP while keeping rust-analyzer attached to the host Rust driver.";
    header.append(titleEl, summaryEl);
  }

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
  const activeExampleEl = root.querySelector<HTMLElement>("#active-example");
  const demoProjectEl = root.querySelector<HTMLElement>("#demo-project");
  const demoSummaryEl = root.querySelector<HTMLElement>("#demo-summary");
  const demoTitleEl = root.querySelector<HTMLElement>("#demo-title");
  const extractionEl = root.querySelector<HTMLElement>("#extraction-state");
  const regenerationModeEl = root.querySelector<HTMLDivElement>("#regeneration-mode");
  const regenerateButton = root.querySelector<HTMLButtonElement>("#regenerate-workspace");
  const eventsEl = root.querySelector<HTMLDivElement>("#events");
  const editorHost = root.querySelector<HTMLDivElement>("#editor");
  const infoviewHost = root.querySelector<HTMLDivElement>("#lean-infoview");
  const documentsEl = root.querySelector<HTMLDivElement>("#documents");
  const examplesEl = root.querySelector<HTMLDivElement>("#examples");

  if (
    !statusPanelEl ||
    !activeExampleEl ||
    !demoProjectEl ||
    !demoSummaryEl ||
    !demoTitleEl ||
    !extractionEl ||
    !regenerationModeEl ||
    !regenerateButton ||
    !eventsEl ||
    !editorHost ||
    !infoviewHost ||
    !documentsEl ||
    !examplesEl
  ) {
    return null;
  }

  let rootUri = "Loading";
  let currentShellView: EditorPlatformShellView | null = null;
  let regenerateAction: (() => void) | null = null;
  let regenerationModeAction: ((mode: RegenerationMode) => void) | null = null;
  const regenerationModeButtons = [...regenerationModeEl.querySelectorAll<HTMLButtonElement>("button[data-mode]")];
  const isRegenerationMode = (value: string | undefined): value is RegenerationMode =>
    value === "manual" || value === "auto";
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
  regenerateButton.addEventListener("click", () => {
    regenerateAction?.();
  });
  for (const button of regenerationModeButtons) {
    button.addEventListener("click", () => {
      if (isRegenerationMode(button.dataset.mode)) {
        regenerationModeAction?.(button.dataset.mode);
      }
    });
  }

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
    renderExampleButtons(examples, activeExampleId, switchExample) {
      examplesEl.replaceChildren();
      for (const example of examples) {
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = example.ready === false;
        button.dataset.active = String(example.id === activeExampleId);
        button.dataset.ready = String(example.ready !== false);
        button.textContent = example.label;
        if (example.summary) {
          button.title = example.summary;
        }
        button.addEventListener("click", () => {
          void switchExample(example);
        });
        examplesEl.append(button);
      }
    },
    setDemoContext({ activeExampleLabel, project, summary, title }) {
      activeExampleEl.textContent = activeExampleLabel ?? "Default";
      demoProjectEl.textContent = project ?? "Lean 4 + CodeMirror 6";
      demoSummaryEl.textContent =
        summary ??
        "This demo mirrors Lean spec comments embedded in Rust into a hidden Lean file, then checks them through the local Lean LSP while keeping rust-analyzer attached to the host Rust driver.";
      demoTitleEl.textContent = title ?? "Embedded Lean over Rust comments";
      document.title = title ?? "Anneal Embedded Lean Demo";
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
    setExtractionState(text: string, tone = "pending") {
      extractionEl.textContent = text;
      extractionEl.dataset.tone = tone;
    },
    setRegenerateAction(action) {
      regenerateAction = action;
    },
    setRegenerateState({ busy = false, enabled, label, title }) {
      regenerateButton.disabled = busy || !enabled;
      regenerateButton.textContent = label ?? (busy ? "Regenerating" : "Regenerate");
      regenerateButton.title = title ?? "";
      regenerateButton.dataset.busy = String(busy);
    },
    setRegenerationMode(mode, enabled) {
      for (const button of regenerationModeButtons) {
        button.disabled = !enabled;
        button.dataset.active = String(button.dataset.mode === mode);
      }
    },
    setRegenerationModeAction(action) {
      regenerationModeAction = action;
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

  const examplesWrap = ownerDocument.createElement("div");
  examplesWrap.className = "examples-wrap";
  examplesWrap.append(sectionHeading(ownerDocument, "Prepared Examples"));
  const examplesEl = ownerDocument.createElement("div");
  examplesEl.id = "examples";
  examplesEl.className = "examples";
  examplesWrap.append(examplesEl);

  const runtimeWrap = ownerDocument.createElement("div");
  runtimeWrap.className = "extraction-wrap";
  runtimeWrap.append(sectionHeading(ownerDocument, "Runtime"));
  const runtimeFacts = ownerDocument.createElement("div");
  runtimeFacts.className = "runtime-facts";
  runtimeFacts.append(
    statusRow(ownerDocument, "Example", "active-example", "Loading"),
    statusRow(ownerDocument, "Extraction", "extraction-state", "Checking", "pending"),
    regenerationModeRow(ownerDocument),
    regenerationActionRow(ownerDocument),
  );
  runtimeWrap.append(runtimeFacts);

  const documentsWrap = ownerDocument.createElement("div");
  documentsWrap.className = "documents-wrap";
  documentsWrap.append(sectionHeading(ownerDocument, "Open Documents"));
  const documentsEl = ownerDocument.createElement("div");
  documentsEl.id = "documents";
  documentsEl.className = "documents";
  documentsWrap.append(documentsEl);

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
  appendHelpItem(helpList, "Prepared examples come from the Anneal extraction flow over local Rust sources.");
  appendHelpItem(
    helpList,
    "Host Rust edits outside embedded Lean blocks flip extraction from ",
    helpCode(ownerDocument, "Fresh"),
    " to ",
    helpCode(ownerDocument, "Stale"),
    ".",
  );

  const eventsEl = ownerDocument.createElement("div");
  eventsEl.id = "events";
  eventsEl.className = "events";

  host.replaceChildren(examplesWrap, runtimeWrap, documentsWrap, helpList, eventsEl);
}

function sectionHeading(ownerDocument: Document, text: string): HTMLElement {
  const heading = ownerDocument.createElement("h3");
  heading.textContent = text;
  return heading;
}

function statusRow(
  ownerDocument: Document,
  label: string,
  id: string,
  value: string,
  tone?: "fresh" | "stale" | "pending",
): HTMLElement {
  const row = ownerDocument.createElement("div");
  row.className = "status-row";
  const labelEl = ownerDocument.createElement("span");
  labelEl.textContent = label;
  const valueEl = ownerDocument.createElement("strong");
  valueEl.id = id;
  valueEl.textContent = value;
  if (tone) {
    valueEl.dataset.tone = tone;
  }
  row.append(labelEl, valueEl);
  return row;
}

function regenerationModeRow(ownerDocument: Document): HTMLElement {
  const row = ownerDocument.createElement("div");
  row.className = "status-row runtime-mode";
  const labelEl = ownerDocument.createElement("span");
  labelEl.textContent = "Mode";
  const control = ownerDocument.createElement("div");
  control.id = "regeneration-mode";
  control.className = "segmented-control";
  control.role = "group";
  control.setAttribute("aria-label", "Regeneration mode");
  for (const [mode, label] of [["manual", "Manual"], ["auto", "Auto"]] as const) {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = label;
    control.append(button);
  }
  row.append(labelEl, control);
  return row;
}

function regenerationActionRow(ownerDocument: Document): HTMLElement {
  const row = ownerDocument.createElement("div");
  row.className = "status-row runtime-actions";
  const labelEl = ownerDocument.createElement("span");
  labelEl.textContent = "Workspace";
  const button = ownerDocument.createElement("button");
  button.id = "regenerate-workspace";
  button.type = "button";
  button.disabled = true;
  button.textContent = "Regenerate";
  row.append(labelEl, button);
  return row;
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
