import { describe, expect, test } from "vitest";

import {
  renderEditorPlatformWorkspaceShell,
  type EditorPlatformWorkspaceShellDocument,
  type EditorPlatformWorkspaceShellElement
} from "../src/index.js";

class TestDocument implements EditorPlatformWorkspaceShellDocument {
  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }
}

class TestElement implements EditorPlatformWorkspaceShellElement {
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

  findBySlot(slot: string): TestElement | undefined {
    if (this.dataset.platformShellSlot === slot) {
      return this;
    }
    for (const child of this.children) {
      const match = child.findBySlot(slot);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
}

describe("editor platform workspace shell", () => {
  test("renders the standard editor, status, info, and secondary slots", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    const shell = renderEditorPlatformWorkspaceShell(container, {
      eyebrow: "Lean 4 + CodeMirror 6",
      ids: {
        info: "lean-infoview"
      },
      labels: {
        editorDescription: "Use language features here.",
        infoTitle: "InfoView"
      }
    });

    expect(container.children).toEqual([shell.root]);
    expect(shell.root.className).toBe("editor-platform-shell");
    expect(attribute(shell.editorHost, "id")).toBe("editor");
    expect(attribute(shell.statusPanel, "id")).toBe("status-panel");
    expect(attribute(shell.infoHost, "id")).toBe("lean-infoview");
    expect(attribute(shell.infoPanel, "aria-label")).toBe("Information");
    expect(attribute(shell.secondaryPanel, "aria-label")).toBe("Help");
    expect(container.text()).toContain("Lean 4 + CodeMirror 6");
    expect(container.text()).toContain("Use language features here.");
    expect(container.text()).toContain("InfoView");
    expect(container.findBySlot("editor")).toBe(shell.editorHost);
    expect(container.findBySlot("status")).toBe(shell.statusPanel);
    expect(container.findBySlot("info")).toBe(shell.infoHost);
    expect(container.findBySlot("secondary")).toBe(shell.secondaryHost);
  });

  test("supports host-specific class names and labels", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    const shell = renderEditorPlatformWorkspaceShell(container, {
      classNames: {
        shell: "shell",
        editorPanel: "panel-editor",
        panel: "panel",
        secondaryPanel: "panel-help"
      },
      labels: {
        editorTitle: "Code",
        infoAriaLabel: "Lean InfoView",
        secondaryTitle: "Tools"
      }
    });

    expect(shell.root.className).toBe("shell");
    expect(shell.editorPanel.className).toBe("panel panel-editor");
    expect(shell.secondaryPanel.className).toBe("panel panel-help");
    expect(attribute(shell.infoPanel, "aria-label")).toBe("Lean InfoView");
    expect(container.text()).toContain("Code");
    expect(container.text()).toContain("Tools");
  });
});

function attribute(element: EditorPlatformWorkspaceShellElement, name: string): string | undefined {
  return (element as TestElement).attributes.get(name);
}
