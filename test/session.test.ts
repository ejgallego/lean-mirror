import { history, undo } from "@codemirror/commands";
import { LSPPlugin } from "@codemirror/lsp-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  LeanEditorSessionDisconnectedError,
  createLeanEditorSession,
  lean4,
  leanFileProgress,
  leanFileProgressMethod,
} from "../src/index.js";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const URI = "file:///Main.lean";

afterEach(() => {
  document.body.innerHTML = "";
});

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

  it("swaps ready client generations without remounting editor state", async () => {
    const session = createLeanEditorSession();
    const firstTransport = initializedTransport();
    const first = session.connect(firstTransport);
    const view = createTestView(
      "def answer := 42\n",
      lean4({ extraExtensions: [history()], session, uri: URI }),
    );

    expect(LSPPlugin.get(view)).toBeNull();
    await first.initialized;
    await waitFor(() => LSPPlugin.get(view)?.client === first.client);
    expect(firstTransport.notifications("textDocument/didOpen")).toHaveLength(1);

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "#check answer\n" },
      selection: { anchor: view.state.doc.length + "#check answer\n".length },
    });
    const editedDocument = view.state.doc.toString();
    const editedSelection = view.state.selection.main.head;

    const secondTransport = initializedTransport();
    const second = session.reconnect(secondTransport);

    expect(LSPPlugin.get(view)).toBeNull();
    await waitFor(
      () => firstTransport.notifications("textDocument/didClose").length === 1,
    );
    await second.initialized;
    await waitFor(() => LSPPlugin.get(view)?.client === second.client);

    expect(view.state.doc.toString()).toBe(editedDocument);
    expect(view.state.selection.main.head).toBe(editedSelection);
    expect(secondTransport.notifications("textDocument/didOpen")).toHaveLength(1);
    expect(secondTransport.notifications("textDocument/didOpen")[0]?.params).toMatchObject({
      textDocument: {
        text: editedDocument,
        uri: URI,
      },
    });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("def answer := 42\n");

    session.dispose();
    expect(LSPPlugin.get(view)).toBeNull();
    await waitFor(
      () => secondTransport.notifications("textDocument/didClose").length === 1,
    );
    view.destroy();
  });

  it("supports independent state subscribers", async () => {
    const session = createLeanEditorSession();
    const states: string[] = [];
    const unsubscribe = session.subscribe(
      (state) => states.push(`${state.generation}:${state.phase}`),
      { emitCurrent: true },
    );

    const connection = session.connect(initializedTransport());
    await connection.initialized;
    unsubscribe();
    session.disconnect();

    expect(states).toEqual(["0:idle", "1:initializing", "1:ready"]);
    session.dispose();
  });

  it("binds extensions created before their view reaches a ready session", async () => {
    const session = createLeanEditorSession();
    const extensions = lean4({ session, uri: URI });
    const transport = initializedTransport();
    const connection = session.connect(transport);
    await connection.initialized;

    const view = createTestView("#check Nat.succ\n", extensions);
    await waitFor(() => LSPPlugin.get(view)?.client === connection.client);
    expect(transport.notifications("textDocument/didOpen")).toHaveLength(1);

    view.destroy();
    session.dispose();
  });
});
