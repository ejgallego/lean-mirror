import { describe, expect, test } from "vitest";

import {
  renderEditorPlatformLogPanel,
  type EditorPlatformLogPanelDocument,
  type EditorPlatformLogPanelElement,
  type LogEvent
} from "../src/index.js";

class TestDocument implements EditorPlatformLogPanelDocument {
  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }
}

class TestElement implements EditorPlatformLogPanelElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestElement[] = [];
  className = "";
  dataset: Record<string, string | undefined> = {};
  textContent: string | null = null;

  constructor(
    readonly ownerDocument: TestDocument,
    readonly tagName: string
  ) {}

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
}

function log(message: string, timestamp: number, level: LogEvent["level"] = "info"): LogEvent {
  return {
    level,
    message,
    timestamp
  };
}

describe("editor platform log panel", () => {
  test("renders newest log entries first by default", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformLogPanel(container, [
      log("first", 1),
      log("second", 2, "warn"),
      { ...log("third", 3), serviceId: "lean", uri: "file:///Main.lean" }
    ]);

    expect(container.attributes.get("aria-label")).toBe("Event log");
    expect(container.children.map((child) => child.className)).toEqual(["event", "event", "event"]);
    expect(container.children.map((child) => child.text())).toEqual(["third", "second", "first"]);
    expect(container.children[0]?.dataset).toMatchObject({
      level: "info",
      serviceId: "lean",
      uri: "file:///Main.lean"
    });
    expect(container.children[1]?.dataset.level).toBe("warn");
  });

  test("supports limits, oldest-first order, custom classes, and custom formatting", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformLogPanel(container, [log("one", 1), log("two", 2), log("three", 3)], {
      ariaLabel: "Runtime events",
      classNames: {
        item: "log-row"
      },
      formatMessage: (event) => `${event.timestamp}: ${event.message}`,
      maxEntries: 2,
      newestFirst: false
    });

    expect(container.attributes.get("aria-label")).toBe("Runtime events");
    expect(container.children.map((child) => child.className)).toEqual(["log-row", "log-row"]);
    expect(container.children.map((child) => child.text())).toEqual(["2: two", "3: three"]);
  });

  test("can filter by log level", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformLogPanel(container, [
      log("debug", 1, "debug"),
      log("info", 2),
      log("warning", 3, "warn")
    ], {
      levels: ["info", "warn"]
    });

    expect(container.children.map((child) => child.text())).toEqual(["warning", "info"]);
  });

  test("can render empty text", () => {
    const document = new TestDocument();
    const container = document.createElement("div");

    renderEditorPlatformLogPanel(container, [], { emptyText: "No events" });

    expect(container.children).toEqual([]);
    expect(container.text()).toBe("No events");
  });
});
