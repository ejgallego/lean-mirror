import { describe, expect, it } from "vitest";

import {
  createMessagePortTransport,
  createWebSocketTransport,
  waitForWebSocketOpen,
} from "../src/index.js";
import { waitFor } from "./support/helpers.js";

describe("transport helpers", () => {
  it("adapts WebSocket-like objects to CodeMirror transports", async () => {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
      addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
        listeners.delete(listener);
      },
    };

    const transport = createWebSocketTransport(socket);
    const received: string[] = [];
    const handler = (message: string) => {
      received.push(message);
    };

    transport.subscribe(handler);
    transport.send("{\"jsonrpc\":\"2.0\"}");
    for (const listener of listeners) {
      listener({ data: "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}" });
    }

    expect(sent).toEqual(["{\"jsonrpc\":\"2.0\"}"]);
    expect(received).toEqual(["{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}"]);

    transport.unsubscribe(handler);
    for (const listener of listeners) {
      listener({ data: "{\"jsonrpc\":\"2.0\",\"method\":\"ignored\"}" });
    }
    expect(received).toHaveLength(1);
  });

  it("adapts MessagePort-like objects to CodeMirror transports", async () => {
    const channel = new MessageChannel();
    const transport = createMessagePortTransport(channel.port1);
    const received: string[] = [];

    transport.subscribe((message) => {
      received.push(message);
    });

    channel.port2.postMessage("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}");
    await waitFor(() => received.length === 1);

    expect(received).toEqual(["{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}"]);
  });

  it("waits for a connecting WebSocket before allowing LSP traffic", async () => {
    const listeners = new Map<"open" | "close" | "error", Set<() => void>>();
    const socket = {
      readyState: 0,
      addEventListener(type: "open" | "close" | "error", listener: () => void) {
        const current = listeners.get(type) ?? new Set();
        current.add(listener);
        listeners.set(type, current);
      },
      removeEventListener(type: "open" | "close" | "error", listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };

    let opened = false;
    const opening = waitForWebSocketOpen(socket).then(() => {
      opened = true;
    });
    expect(opened).toBe(false);

    socket.readyState = 1;
    for (const listener of listeners.get("open") ?? []) {
      listener();
    }
    await opening;

    expect(opened).toBe(true);
    expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(true);
  });

  it("reports sends attempted before a WebSocket is open", () => {
    const socket = {
      readyState: 0,
      send() {},
      addEventListener() {},
      removeEventListener() {},
    };

    expect(() => createWebSocketTransport(socket).send("{}")).toThrow(/readyState is 0/);
  });

  it("ignores terminal sends during WebSocket teardown", () => {
    let sends = 0;
    const socket = {
      readyState: 2,
      send() {
        sends += 1;
      },
      addEventListener() {},
      removeEventListener() {},
    };

    expect(() => createWebSocketTransport(socket).send("{}")).not.toThrow();
    expect(sends).toBe(0);
  });
});
