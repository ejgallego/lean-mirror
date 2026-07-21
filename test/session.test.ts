import { describe, expect, it } from "vitest";

import {
  LeanEditorSessionDisconnectedError,
  createLeanEditorSession,
  leanFileProgress,
  leanFileProgressMethod,
} from "../src/index.js";
import { MockTransport } from "./support/mockTransport.js";

function initializedTransport(): MockTransport {
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      textDocumentSync: 2,
    },
  }));
  return transport;
}

describe("LeanEditorSession", () => {
  it("owns client generations, progress cleanup, and transport disposal", async () => {
    const states: string[] = [];
    const progress = leanFileProgress();
    let disposedTransports = 0;
    const session = createLeanEditorSession({
      client: {
        extensions: [progress],
      },
      onStateChange(state) {
        states.push(`${state.generation}:${state.phase}`);
      },
    });

    const first = session.connect(initializedTransport(), {
      disposeTransport() {
        disposedTransports++;
      },
    });
    await first.initialized;
    expect(session.client).toBe(first.client);
    expect(session.state).toEqual({ generation: 1, phase: "ready" });

    const firstTransport = initializedTransport();
    const second = session.reconnect(firstTransport, {
      disposeTransport() {
        disposedTransports++;
      },
    });
    await second.initialized;

    expect(second.client).not.toBe(first.client);
    expect(second.generation).toBe(2);
    expect(disposedTransports).toBe(1);
    expect(states).toEqual([
      "1:initializing",
      "1:ready",
      "1:idle",
      "2:initializing",
      "2:ready",
    ]);

    firstTransport.emitNotification(leanFileProgressMethod, {
      processing: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      }],
      textDocument: {
        uri: "file:///Main.lean",
        version: 0,
      },
    });
    expect(progress.store.entries()).toHaveLength(1);

    session.dispose();
    expect(progress.store.entries()).toEqual([]);
    expect(disposedTransports).toBe(2);
    expect(session.client).toBeNull();
    expect(session.state).toEqual({ generation: 2, phase: "disposed" });
    expect(() => session.connect(initializedTransport())).toThrow(/disposed/);
  });

  it("rejects initialization when disconnected before the server is ready", async () => {
    const session = createLeanEditorSession({
      client: {
        timeout: 10,
      },
    });
    const connection = session.connect(new MockTransport());

    connection.disconnect();

    await expect(connection.initialized).rejects.toBeInstanceOf(
      LeanEditorSessionDisconnectedError,
    );
    expect(session.state).toEqual({ generation: 1, phase: "idle" });
  });

  it("recovers from failed initialization with a fresh client generation", async () => {
    const states: string[] = [];
    let disposedTransports = 0;
    const failedTransport = new MockTransport();
    failedTransport.onRequest("initialize", () => {
      throw new Error("synthetic initialization failure");
    });
    const session = createLeanEditorSession({
      onStateChange(state) {
        states.push(`${state.generation}:${state.phase}`);
      },
    });

    const failed = session.connect(failedTransport, {
      disposeTransport() {
        disposedTransports++;
      },
    });
    await expect(failed.initialized).rejects.toThrow(/synthetic initialization failure/);
    expect(session.state).toMatchObject({ generation: 1, phase: "failed" });

    const recovered = session.reconnect(initializedTransport(), {
      disposeTransport() {
        disposedTransports++;
      },
    });
    await recovered.initialized;

    expect(recovered.generation).toBe(2);
    expect(recovered.client).not.toBe(failed.client);
    expect(disposedTransports).toBe(1);
    expect(states).toEqual([
      "1:initializing",
      "1:failed",
      "1:idle",
      "2:initializing",
      "2:ready",
    ]);

    session.dispose();
    expect(disposedTransports).toBe(2);
  });

  it("requires reconnect when a generation is already active", () => {
    const session = createLeanEditorSession();
    session.connect(new MockTransport());

    expect(() => session.connect(new MockTransport())).toThrow(/reconnect/);
    session.dispose();
  });
});
