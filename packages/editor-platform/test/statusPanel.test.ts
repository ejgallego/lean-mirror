import { describe, expect, test } from "vitest";

import {
  createEditorPlatformShellView,
  renderEditorPlatformStatusPanel,
  type EditorPlatformSnapshot,
  type EditorPlatformStatusPanelDocument,
  type EditorPlatformStatusPanelElement
} from "../src/index.js";

class TestDocument implements EditorPlatformStatusPanelDocument {
  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }
}

class TestElement implements EditorPlatformStatusPanelElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestElement[] = [];
  className = "";
  dataset: Record<string, string | undefined> = {};
  textContent: string | null = null;

  constructor(
    readonly ownerDocument: TestDocument,
    readonly tagName: string
  ) {}

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: TestElement[]): void {
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

  findByClass(className: string): TestElement[] {
    const matches = this.className.split(/\s+/).includes(className) ? [this] : [];
    return [...matches, ...this.children.flatMap((child) => child.findByClass(className))];
  }
}

function snapshot(): EditorPlatformSnapshot {
  return {
    activeDocumentUri: "file:///workspace/Main.lean",
    services: {
      lean: {
        id: "lean",
        kind: "lean-lsp",
        label: "Lean",
        status: { state: "ready" },
        documents: [],
        updatedAt: 1
      },
      rust: {
        id: "rust",
        kind: "rust-lsp",
        label: "Rust",
        status: { state: "initializing" },
        documents: [],
        updatedAt: 2
      }
    },
    documents: {},
    diagnostics: [
      { uri: "file:///workspace/Main.lean", severity: "error", message: "unknown" },
      { uri: "file:///workspace/Helper.lean", severity: "warning", message: "unused" }
    ],
    logs: []
  };
}

describe("editor platform status panel", () => {
  test("renders compact status rows from a shell view", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformStatusPanel(container, createEditorPlatformShellView(snapshot()), {
      workspaceUri: "file:///workspace"
    });

    expect(container.attributes.get("aria-label")).toBe("Runtime status");
    expect(container.children.map((row) => row.children[0]?.text())).toEqual([
      "Status",
      "Services",
      "Diagnostics",
      "Document",
      "Workspace"
    ]);
    expect(container.text()).toContain("Ready");
    expect(container.text()).toContain("Lean");
    expect(container.text()).toContain("Rust");
    expect(container.text()).toContain("1 error, 0 warnings");
    expect(container.text()).toContain("file:///workspace/Main.lean");
    expect(container.text()).toContain("file:///workspace");
    expect(container.children.map((row) => row.dataset.platformStatusKind)).toEqual([
      "status",
      "services",
      "diagnostics",
      "document",
      "workspace"
    ]);
  });

  test("marks service rows with light states", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformStatusPanel(container, createEditorPlatformShellView(snapshot()));

    expect(container.findByClass("service-status").map((row) => row.dataset.state)).toEqual([
      "ready",
      "pending"
    ]);
  });

  test("supports custom labels and global diagnostics", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformStatusPanel(container, createEditorPlatformShellView(snapshot()), {
      diagnosticsScope: "all",
      labels: {
        diagnostics: "All Diagnostics"
      }
    });

    expect(container.children.map((row) => row.children[0]?.text())).toContain("All Diagnostics");
    expect(container.text()).toContain("1 error, 1 warning");
  });
});
