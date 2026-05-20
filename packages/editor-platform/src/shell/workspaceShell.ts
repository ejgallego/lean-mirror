export interface EditorPlatformWorkspaceShellDocument {
  createElement(tagName: string): EditorPlatformWorkspaceShellElement;
}

export interface EditorPlatformWorkspaceShellElement {
  ownerDocument: EditorPlatformWorkspaceShellDocument;
  className: string;
  dataset?: Record<string, string | undefined> | undefined;
  textContent: string | null;
  append(...children: any[]): void;
  replaceChildren(...children: any[]): void;
  setAttribute(name: string, value: string): void;
}

export interface EditorPlatformWorkspaceShellClassNames {
  shell: string;
  header: string;
  eyebrow: string;
  layout: string;
  sideRail: string;
  panel: string;
  panelHead: string;
  editorPanel: string;
  editorHost: string;
  statusPanel: string;
  infoPanel: string;
  infoHost: string;
  secondaryPanel: string;
  secondaryHost: string;
}

export interface EditorPlatformWorkspaceShellSlotIds {
  editor: string;
  status: string;
  info: string;
}

export interface EditorPlatformWorkspaceShellLabels {
  editorTitle: string;
  editorDescription?: string;
  infoTitle: string;
  infoAriaLabel: string;
  secondaryTitle: string;
  secondaryAriaLabel: string;
}

export interface RenderEditorPlatformWorkspaceShellOptions {
  classNames?: Partial<EditorPlatformWorkspaceShellClassNames> | undefined;
  eyebrow?: string | undefined;
  ids?: Partial<EditorPlatformWorkspaceShellSlotIds> | undefined;
  labels?: Partial<EditorPlatformWorkspaceShellLabels> | undefined;
}

export interface EditorPlatformWorkspaceShell {
  root: EditorPlatformWorkspaceShellElement;
  editorPanel: EditorPlatformWorkspaceShellElement;
  editorHost: EditorPlatformWorkspaceShellElement;
  sideRail: EditorPlatformWorkspaceShellElement;
  statusPanel: EditorPlatformWorkspaceShellElement;
  infoPanel: EditorPlatformWorkspaceShellElement;
  infoHost: EditorPlatformWorkspaceShellElement;
  secondaryPanel: EditorPlatformWorkspaceShellElement;
  secondaryHost: EditorPlatformWorkspaceShellElement;
}

type WorkspaceShellSlot =
  | "editor"
  | "editor-panel"
  | "info"
  | "info-panel"
  | "root"
  | "secondary"
  | "secondary-panel"
  | "side-rail"
  | "status";

const defaultClassNames: EditorPlatformWorkspaceShellClassNames = {
  shell: "editor-platform-shell",
  header: "editor-platform-shell-header",
  eyebrow: "editor-platform-shell-eyebrow",
  layout: "editor-platform-layout",
  sideRail: "editor-platform-side-rail",
  panel: "editor-platform-panel",
  panelHead: "editor-platform-panel-head",
  editorPanel: "editor-platform-panel-editor",
  editorHost: "editor-platform-editor-host",
  statusPanel: "editor-platform-status-card",
  infoPanel: "editor-platform-panel-info",
  infoHost: "editor-platform-info-host",
  secondaryPanel: "editor-platform-panel-secondary",
  secondaryHost: "editor-platform-secondary-host"
};

const defaultSlotIds: EditorPlatformWorkspaceShellSlotIds = {
  editor: "editor",
  status: "status-panel",
  info: "info-view"
};

const defaultLabels: EditorPlatformWorkspaceShellLabels = {
  editorTitle: "Editor",
  infoTitle: "Info",
  infoAriaLabel: "Information",
  secondaryTitle: "Help",
  secondaryAriaLabel: "Help"
};

export function renderEditorPlatformWorkspaceShell(
  container: EditorPlatformWorkspaceShellElement,
  options: RenderEditorPlatformWorkspaceShellOptions = {}
): EditorPlatformWorkspaceShell {
  const document = container.ownerDocument;
  const classNames = { ...defaultClassNames, ...options.classNames };
  const ids = { ...defaultSlotIds, ...options.ids };
  const labels = { ...defaultLabels, ...options.labels };

  const root = shellElement(document, "div", classNames.shell, "root");
  if (options.eyebrow) {
    const header = shellElement(document, "header", classNames.header);
    const eyebrow = shellElement(document, "p", classNames.eyebrow);
    eyebrow.textContent = options.eyebrow;
    header.append(eyebrow);
    root.append(header);
  }

  const layout = shellElement(document, "main", classNames.layout);
  const editorPanel = shellElement(
    document,
    "section",
    joinClassNames(classNames.panel, classNames.editorPanel),
    "editor-panel"
  );
  appendPanelHead(document, editorPanel, classNames.panelHead, labels.editorTitle, labels.editorDescription);
  const editorHost = shellElement(document, "div", classNames.editorHost, "editor");
  editorHost.setAttribute("id", ids.editor);
  editorPanel.append(editorHost);

  const sideRail = shellElement(document, "aside", classNames.sideRail, "side-rail");
  const statusPanel = shellElement(document, "div", classNames.statusPanel, "status");
  statusPanel.setAttribute("id", ids.status);
  statusPanel.setAttribute("aria-label", "Runtime status");

  const infoPanel = shellElement(
    document,
    "section",
    joinClassNames(classNames.panel, classNames.infoPanel),
    "info-panel"
  );
  infoPanel.setAttribute("aria-label", labels.infoAriaLabel);
  appendPanelHead(document, infoPanel, classNames.panelHead, labels.infoTitle);
  const infoHost = shellElement(document, "div", classNames.infoHost, "info");
  infoHost.setAttribute("id", ids.info);
  infoPanel.append(infoHost);

  const secondaryPanel = shellElement(
    document,
    "section",
    joinClassNames(classNames.panel, classNames.secondaryPanel),
    "secondary-panel"
  );
  secondaryPanel.setAttribute("aria-label", labels.secondaryAriaLabel);
  appendPanelHead(document, secondaryPanel, classNames.panelHead, labels.secondaryTitle);
  const secondaryHost = shellElement(document, "div", classNames.secondaryHost, "secondary");
  secondaryPanel.append(secondaryHost);

  sideRail.append(statusPanel, infoPanel, secondaryPanel);
  layout.append(editorPanel, sideRail);
  root.append(layout);
  container.replaceChildren(root);

  return {
    root,
    editorPanel,
    editorHost,
    sideRail,
    statusPanel,
    infoPanel,
    infoHost,
    secondaryPanel,
    secondaryHost
  };
}

function appendPanelHead(
  document: EditorPlatformWorkspaceShellDocument,
  panel: EditorPlatformWorkspaceShellElement,
  className: string,
  title: string,
  description?: string
): void {
  const head = shellElement(document, "div", className);
  const heading = shellElement(document, "h2");
  heading.textContent = title;
  head.append(heading);
  if (description) {
    const paragraph = shellElement(document, "p");
    paragraph.textContent = description;
    head.append(paragraph);
  }
  panel.append(head);
}

function joinClassNames(...classNames: readonly string[]): string {
  return classNames.filter(Boolean).join(" ");
}

function shellElement(
  document: EditorPlatformWorkspaceShellDocument,
  tagName: string,
  className = "",
  slot?: WorkspaceShellSlot
): EditorPlatformWorkspaceShellElement {
  const element = document.createElement(tagName);
  element.className = className;
  if (slot && element.dataset) {
    element.dataset.platformShellSlot = slot;
  }
  return element;
}
