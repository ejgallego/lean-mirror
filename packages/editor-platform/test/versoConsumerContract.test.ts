import { describe, expect, test } from "vitest";

import {
  createDocumentSnapshot,
  createEditorPlatformShellView,
  EditorPlatformStore,
  EditorServiceRuntime,
  renderEditorPlatformLogPanel,
  renderEditorPlatformStatusPanel,
  renderEditorPlatformWorkspaceShell,
  type DocumentSyncState,
  type EditorDiagnostic,
  type EditorPlatformLogPanelDocument,
  type EditorPlatformLogPanelElement,
  type EditorPlatformShellView,
  type EditorPlatformSnapshot,
  type EditorPlatformStatusPanelDocument,
  type EditorPlatformStatusPanelElement,
  type EditorPlatformWorkspaceShellDocument,
  type EditorPlatformWorkspaceShellElement,
  type EditorServiceDescriptor,
  type LogEvent,
  type ServiceConnectionStatus
} from "../src/index.js";

type ContractDocument = EditorPlatformLogPanelDocument &
  EditorPlatformStatusPanelDocument &
  EditorPlatformWorkspaceShellDocument;

type ContractElement = EditorPlatformLogPanelElement &
  EditorPlatformStatusPanelElement &
  EditorPlatformWorkspaceShellElement;

class VersoContractDocument implements ContractDocument {
  createElement(tagName: string): VersoContractElement {
    return new VersoContractElement(this, tagName);
  }
}

class VersoContractElement implements ContractElement {
  readonly attributes = new Map<string, string>();
  readonly children: VersoContractElement[] = [];
  className = "";
  dataset: Record<string, string | undefined> = {};
  textContent: string | null = null;

  constructor(
    readonly ownerDocument: VersoContractDocument,
    readonly tagName: string
  ) {}

  append(...children: VersoContractElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: VersoContractElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
    this.textContent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  text(): string {
    return this.textContent ?? this.children.map((child) => child.text()).join("");
  }
}

describe("Verso editor-platform consumer contract", () => {
  test("composes the service, document, diagnostics, status, log, and workspace APIs", () => {
    const service: EditorServiceDescriptor = {
      id: "lean-authority",
      kind: "verso-parser",
      label: "Lean Authority"
    };
    const connection: ServiceConnectionStatus = {
      phase: "ready",
      message: "Lean structure current"
    };
    const syncState: DocumentSyncState = "clean";
    const uri = "verso-entry://manual-intro";
    const diagnostic: EditorDiagnostic = {
      message: "Unknown role",
      severity: "warning",
      uri
    };

    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(store, service);
    store.setDocument(createDocumentSnapshot({
      languageId: "lean4",
      openState: "open",
      syncState,
      title: "Manual introduction",
      uri,
      version: 3
    }));
    store.setActiveDocument(uri);
    store.setDocumentDiagnostics(uri, [diagnostic]);
    runtime.recordConnectionStatus(connection);

    const snapshot: EditorPlatformSnapshot = store.snapshot;
    const view: EditorPlatformShellView = createEditorPlatformShellView(snapshot);
    const document = new VersoContractDocument();
    const container = document.createElement("div");
    const shell = renderEditorPlatformWorkspaceShell(container, {
      classNames: {
        shell: "workbench-platform-shell"
      },
      labels: {
        editorTitle: "Verso Editor",
        infoTitle: "Commands",
        secondaryTitle: "Diagnostics"
      }
    });

    renderEditorPlatformStatusPanel(shell.statusPanel, view, {
      diagnosticsScope: "active-document",
      labels: {
        diagnostics: "Draft Diagnostics"
      },
      workspaceUri: "verso-mirror"
    });
    renderEditorPlatformLogPanel(shell.secondaryHost, snapshot.logs, {
      formatMessage: (event: LogEvent) => `${event.level.toUpperCase()} ${event.message}`,
      maxEntries: 8
    });

    expect(container.text()).toContain("Verso Editor");
    expect(elementText(shell.statusPanel)).toContain("Lean Authority");
    expect(elementText(shell.statusPanel)).toContain("1 warning");
    expect(elementText(shell.secondaryHost)).toContain("Lean Authority ready");
  });
});

function elementText(element: ContractElement): string {
  return (element as VersoContractElement).text();
}
