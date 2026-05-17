import { describe, expect, test } from "vitest";

import {
  createEditorEndpoint,
  createHostEndpoint,
  EditorPlatformStore,
  platformMessage,
  publishPlatformSnapshots,
  type EditorPlatformMessage,
  type EditorPlatformMessageSource,
  type EditorPlatformMessageTarget,
  type EditorToHostMessage,
  type HostToEditorMessage,
  type Unsubscribe
} from "../src/index.js";

class MemorySource implements EditorPlatformMessageSource {
  private readonly listeners = new Set<(message: unknown) => void>();

  subscribe(listener: (message: unknown) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(message: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

class MemoryTarget<TMessage extends EditorPlatformMessage> implements EditorPlatformMessageTarget<TMessage> {
  readonly messages: TMessage[] = [];

  postMessage(message: TMessage): void {
    this.messages.push(message);
  }
}

describe("editor platform endpoint", () => {
  test("routes editor-to-host messages through a host endpoint", () => {
    const target = new MemoryTarget<HostToEditorMessage>();
    const source = new MemorySource();
    const endpoint = createHostEndpoint(target, source);
    const received: EditorToHostMessage[] = [];
    endpoint.subscribe((message) => {
      received.push(message);
    });

    const ready = platformMessage("ready");
    source.emit(ready);
    endpoint.postMessage(
      platformMessage("service-event", {
        event: {
          type: "ready" as const,
          serviceId: "lean"
        }
      })
    );

    expect(received).toEqual([ready]);
    expect(target.messages).toHaveLength(1);
    expect(target.messages[0]?.type).toBe("service-event");
  });

  test("rejects messages that belong to the opposite endpoint direction", () => {
    const target = new MemoryTarget<EditorToHostMessage>();
    const source = new MemorySource();
    const invalid: unknown[] = [];
    const endpoint = createEditorEndpoint(target, source, {
      onInvalidMessage: (message) => {
        invalid.push(message);
      }
    });
    const received: HostToEditorMessage[] = [];
    endpoint.subscribe((message) => {
      received.push(message);
    });

    source.emit(platformMessage("ready"));
    source.emit(
      platformMessage("log", {
        event: {
          level: "info",
          message: "Connected",
          timestamp: 1
        }
      })
    );

    expect(received.map((message) => message.type)).toEqual(["log"]);
    expect(invalid.map((message) => (message as EditorPlatformMessage).type)).toEqual(["ready"]);
  });

  test("stops receiving source messages after disposal", () => {
    const target = new MemoryTarget<HostToEditorMessage>();
    const source = new MemorySource();
    const endpoint = createHostEndpoint(target, source);
    const received: EditorToHostMessage[] = [];
    endpoint.subscribe((message) => {
      received.push(message);
    });

    endpoint.dispose();
    source.emit(platformMessage("ready"));

    expect(received).toEqual([]);
  });
});

describe("publishPlatformSnapshots", () => {
  test("publishes the current and updated store snapshots", () => {
    const store = new EditorPlatformStore();
    const target = new MemoryTarget<HostToEditorMessage>();

    const unsubscribe = publishPlatformSnapshots(store, target);
    store.setActiveDocument("file:///Main.lean");
    unsubscribe();
    store.setActiveDocument("file:///Ignored.lean");

    expect(target.messages).toHaveLength(2);
    expect(target.messages.map((message) => message.type)).toEqual(["platform-snapshot", "platform-snapshot"]);
    const update = target.messages[1];
    expect(update?.type).toBe("platform-snapshot");
    if (update?.type !== "platform-snapshot") {
      throw new Error("Expected a platform snapshot message.");
    }
    expect(update.payload.snapshot.activeDocumentUri).toBe("file:///Main.lean");
  });
});
