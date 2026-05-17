import { describe, expect, test } from "vitest";

import {
  createMessageEventSource,
  createOnDidReceiveMessageSource,
  createPostMessageTarget,
  platformMessage,
  type DisposableLike,
  type EditorToHostMessage,
  type MessageEventLike,
  type MessageEventTargetLike
} from "../src/index.js";

class FakeMessageEventTarget implements MessageEventTargetLike {
  private readonly listeners = new Set<(event: MessageEventLike) => void>();

  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void {
    expect(type).toBe("message");
    this.listeners.add(listener);
  }

  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void {
    expect(type).toBe("message");
    this.listeners.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data });
    }
  }
}

class FakeOnDidReceiveMessageSource {
  private readonly listeners = new Set<(message: unknown) => void>();

  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  emit(message: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

describe("protocol adapters", () => {
  test("forwards postMessage targets", () => {
    const messages: EditorToHostMessage[] = [];
    const target = createPostMessageTarget<EditorToHostMessage>({
      postMessage(message) {
        messages.push(message);
      }
    });

    target.postMessage(platformMessage("ready"));

    expect(messages.map((message) => message.type)).toEqual(["ready"]);
  });

  test("adapts browser-style message events", () => {
    const sourceTarget = new FakeMessageEventTarget();
    const source = createMessageEventSource(sourceTarget);
    const received: unknown[] = [];

    const unsubscribe = source.subscribe((message) => {
      received.push(message);
    });
    sourceTarget.emit(platformMessage("ready"));
    unsubscribe();
    sourceTarget.emit(platformMessage("open-document", { uri: "file:///Ignored.lean" }));

    expect(received).toEqual([platformMessage("ready")]);
  });

  test("adapts VS Code-style disposable message sources", () => {
    const sourceTarget = new FakeOnDidReceiveMessageSource();
    const source = createOnDidReceiveMessageSource(sourceTarget);
    const received: unknown[] = [];

    const unsubscribe = source.subscribe((message) => {
      received.push(message);
    });
    sourceTarget.emit(platformMessage("ready"));
    unsubscribe();
    sourceTarget.emit(platformMessage("open-document", { uri: "file:///Ignored.lean" }));

    expect(received).toEqual([platformMessage("ready")]);
  });
});
