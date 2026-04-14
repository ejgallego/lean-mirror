import { describe, expect, it } from "vitest";

import { createMessagePortTransport, createWebSocketTransport } from "../src/index.js";
import { delay } from "./support/helpers.js";

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
    await delay(0);

    expect(received).toEqual(["{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}"]);
  });
});
