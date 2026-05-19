import type { EditorPlatformShellView, EditorServiceStatusView } from "./shellView.js";

export interface EditorPlatformStatusPanelDocument {
  createElement(tagName: string): EditorPlatformStatusPanelElement;
}

export interface EditorPlatformStatusPanelElement {
  ownerDocument: EditorPlatformStatusPanelDocument;
  className: string;
  dataset?: Record<string, string | undefined> | undefined;
  textContent: string | null;
  // Keep these structural so HTMLElement can satisfy this interface without adding DOM libs to the package.
  append(...children: any[]): void;
  replaceChildren(...children: any[]): void;
  setAttribute(name: string, value: string): void;
}

export interface EditorPlatformStatusPanelLabels {
  status: string;
  services: string;
  diagnostics: string;
  document: string;
  workspace: string;
}

export interface EditorPlatformStatusPanelClassNames {
  row: string;
  services: string;
  service: string;
  serviceLight: string;
}

export interface RenderEditorPlatformStatusPanelOptions {
  ariaLabel?: string | undefined;
  classNames?: Partial<EditorPlatformStatusPanelClassNames> | undefined;
  diagnosticsScope?: "active-document" | "all" | undefined;
  emptyDocumentText?: string | undefined;
  emptyServicesText?: string | undefined;
  labels?: Partial<EditorPlatformStatusPanelLabels> | undefined;
  workspaceUri?: string | undefined;
}

type StatusPanelRowKind = "status" | "services" | "diagnostics" | "document" | "workspace";

const defaultLabels: EditorPlatformStatusPanelLabels = {
  status: "Status",
  services: "Services",
  diagnostics: "Diagnostics",
  document: "Document",
  workspace: "Workspace"
};

const defaultClassNames: EditorPlatformStatusPanelClassNames = {
  row: "status-row",
  services: "service-statuses",
  service: "service-status",
  serviceLight: "service-light"
};

export function renderEditorPlatformStatusPanel(
  container: EditorPlatformStatusPanelElement,
  view: EditorPlatformShellView,
  options: RenderEditorPlatformStatusPanelOptions = {}
): void {
  const document = container.ownerDocument;
  const labels = { ...defaultLabels, ...options.labels };
  const classNames = { ...defaultClassNames, ...options.classNames };
  const diagnosticsText =
    (options.diagnosticsScope ?? "active-document") === "active-document" && view.activeDocumentUri
      ? view.activeDocumentDiagnosticsText
      : view.diagnosticsText;
  const rows = [
    statusPanelRow(document, classNames.row, "status", labels.status, view.statusText, "strong"),
    servicesPanelRow(document, classNames, labels.services, view.services, options.emptyServicesText ?? "Starting"),
    statusPanelRow(document, classNames.row, "diagnostics", labels.diagnostics, diagnosticsText, "strong"),
    statusPanelRow(
      document,
      classNames.row,
      "document",
      labels.document,
      view.activeDocumentUri ?? options.emptyDocumentText ?? "Loading",
      "code"
    )
  ];

  if (options.workspaceUri !== undefined) {
    rows.push(statusPanelRow(document, classNames.row, "workspace", labels.workspace, options.workspaceUri, "code"));
  }

  container.setAttribute("aria-label", options.ariaLabel ?? "Runtime status");
  container.replaceChildren(...rows);
}

function statusPanelRow(
  document: EditorPlatformStatusPanelDocument,
  className: string,
  kind: StatusPanelRowKind,
  labelText: string,
  valueText: string,
  valueTagName: "code" | "strong"
): EditorPlatformStatusPanelElement {
  const row = document.createElement("div");
  row.className = className;
  setStatusPanelDataset(row, "row", kind);

  const label = document.createElement("span");
  label.textContent = labelText;
  setStatusPanelDataset(label, "label", kind);

  const value = document.createElement(valueTagName);
  value.textContent = valueText;
  setStatusPanelDataset(value, "value", kind);

  row.append(label, value);
  return row;
}

function servicesPanelRow(
  document: EditorPlatformStatusPanelDocument,
  classNames: EditorPlatformStatusPanelClassNames,
  labelText: string,
  services: readonly EditorServiceStatusView[],
  emptyServicesText: string
): EditorPlatformStatusPanelElement {
  const row = document.createElement("div");
  row.className = classNames.row;
  setStatusPanelDataset(row, "row", "services");

  const label = document.createElement("span");
  label.textContent = labelText;
  setStatusPanelDataset(label, "label", "services");

  const servicesEl = document.createElement("div");
  servicesEl.className = classNames.services;
  setStatusPanelDataset(servicesEl, "value", "services");
  if (services.length === 0) {
    servicesEl.textContent = emptyServicesText;
  } else {
    servicesEl.replaceChildren(...services.map((service) => serviceStatusElement(document, classNames, service)));
  }

  row.append(label, servicesEl);
  return row;
}

function setStatusPanelDataset(
  element: EditorPlatformStatusPanelElement,
  part: "label" | "row" | "value",
  kind: StatusPanelRowKind
): void {
  if (!element.dataset) {
    return;
  }
  element.dataset.platformStatusPart = part;
  element.dataset.platformStatusKind = kind;
}

function serviceStatusElement(
  document: EditorPlatformStatusPanelDocument,
  classNames: EditorPlatformStatusPanelClassNames,
  service: EditorServiceStatusView
): EditorPlatformStatusPanelElement {
  const row = document.createElement("div");
  row.className = classNames.service;
  if (row.dataset) {
    row.dataset.state = service.lightState;
  }

  const light = document.createElement("span");
  light.className = classNames.serviceLight;
  light.setAttribute("aria-hidden", "true");

  const label = document.createElement("strong");
  label.textContent = service.label;

  const status = document.createElement("code");
  status.textContent = service.statusLabel;

  row.append(light, label, status);
  return row;
}
