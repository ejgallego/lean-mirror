import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPPlugin } from "@codemirror/lsp-client";
import {
  applyLeanWorkspaceEdit, createLeanEditorSession, createLeanLspClient,
  createLeanWorkspace, lean4, type LeanEditorSession, type LeanWorkspace,
} from "../src/index.js";
import { createTestView } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

function transport() {
  const result = new MockTransport();
  result.onRequest("initialize", () => ({ capabilities: { textDocumentSync: 2 } }));
  return result;
}
afterEach(() => { document.body.innerHTML = ""; });

describe("review lifecycle regressions", () => {
  it("rejects pending and subsequent requests when a generation retires", async () => {
    const session = createLeanEditorSession({ client: { timeout: 60_000 } });
    const connection = session.connect(transport());
    await connection.initialized;
    const pending = connection.client.request("pending", {});
    const rejected = expect(pending).rejects.toThrow(/disconnected/);
    session.disconnect();
    await rejected;
    expect(connection.client.connected).toBe(false);
    await expect(connection.client.request("late", {})).rejects.toThrow(/disconnected/);
    session.dispose();
  });

  it("settles requests queued behind initialization on disconnect", async () => {
    const session = createLeanEditorSession();
    const connection = session.connect(new MockTransport());
    const initialized = expect(connection.initialized).rejects.toThrow(/disconnected/);
    const queued = expect(connection.client.request("queued", {})).rejects.toThrow(/disconnected/);
    session.disconnect();
    await Promise.all([initialized, queued]);
    session.dispose();
  });

  it("does not apply a loaded edit from an old generation to host text", async () => {
    let finish!: (value: string) => void;
    let text = "original";
    const session = createLeanEditorSession({ client: { workspace: createLeanWorkspace({
      loadDocument: () => new Promise<string>((resolve) => { finish = resolve; }),
      onDocumentChange: (_uri, file) => { text = file.doc.toString(); },
    }) } });
    const old = session.connect(transport());
    await old.initialized;
    const applying = applyLeanWorkspaceEdit(old.client, { changes: { "file:///Other.lean": [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
      newText: "OLD-GENERATION",
    }] } });
    const next = session.reconnect(transport());
    await next.initialized;
    finish(text);
    expect(await applying).toMatchObject({ applied: false, changedUris: [] });
    expect(text).toBe("original");
    session.dispose();
  });

  it("delivers teardown to editor bindings after a UI observer throws", async () => {
    const errors: unknown[] = [];
    const session = createLeanEditorSession({ onObserverError: (error) => { errors.push(error); } });
    const connection = session.connect(transport());
    await connection.initialized;
    session.subscribe((state) => { if (state.phase === "idle") throw new Error("UI failed"); });
    const view = createTestView("#check Nat", lean4({ session, uri: "file:///Main.lean" }));
    expect(LSPPlugin.get(view)?.client).toBe(connection.client);
    session.disconnect();
    expect(LSPPlugin.get(view)).toBeNull();
    expect(errors).toHaveLength(1);
    view.destroy();
    session.dispose();
  });

  it("does not initialize a transport after an observer disposes the session", async () => {
    let session!: LeanEditorSession;
    const disposeTransport = vi.fn();
    session = createLeanEditorSession({ onStateChange(state) {
      if (state.phase === "initializing") session.dispose();
    } });
    const wire = transport();
    const connection = session.connect(wire, { disposeTransport });
    await expect(connection.initialized).rejects.toThrow(/disconnected/);
    expect(wire.sent).toEqual([]);
    expect(disposeTransport).toHaveBeenCalledOnce();
    expect(session.state.phase).toBe("disposed");
  });

  it("allows an observer to replace a connecting generation without starting the old one", async () => {
    let session!: LeanEditorSession;
    const first = transport();
    const second = transport();
    session = createLeanEditorSession({ onStateChange(state) {
      if (state.phase === "initializing" && state.generation === 1) session.reconnect(second);
    } });
    const old = session.connect(first);
    await expect(old.initialized).rejects.toThrow(/disconnected/);
    await session.connection!.initialized;
    expect(first.sent).toEqual([]);
    expect(second.requests("initialize")).toHaveLength(1);
    expect(session.state).toMatchObject({ generation: 2, phase: "ready" });
    session.dispose();
  });

  it("does not let a late loader rewind a document created while it waited", async () => {
    let finish!: (value: { doc: string; version: number }) => void;
    const client = createLeanLspClient({ workspace: createLeanWorkspace({
      loadDocument: () => new Promise((resolve) => { finish = resolve; }),
    }) });
    const workspace = client.workspace as LeanWorkspace;
    const uri = "file:///Late.lean";
    const loading = workspace.requestFile(uri);
    const view = createTestView("x", []);
    workspace.openFile(uri, "lean4", view);
    workspace.closeFile(uri, view);
    workspace.updateFile(uri, { changes: { from: 1, insert: "1" } });
    workspace.updateFile(uri, { changes: { from: 2, insert: "2" } });
    const before = workspace.getFile(uri)!.version;
    finish({ doc: "x", version: 0 });
    await loading;
    workspace.updateFile(uri, { changes: { from: 3, insert: "3" } });
    expect(workspace.getFile(uri)!.version).toBeGreaterThan(before);
    expect(workspace.getFile(uri)!.doc.toString()).toBe("x123");
    view.destroy();
  });

  it("asks the host to activate a retained view on every display request", async () => {
    const displayDocument = vi.fn(() => view);
    const client = createLeanLspClient({ workspace: createLeanWorkspace({ displayDocument }) });
    const workspace = client.workspace as LeanWorkspace;
    const view = createTestView("#check Nat", []);
    workspace.openFile("file:///Main.lean", "lean4", view);
    expect(await workspace.displayFile("file:///Main.lean")).toBe(view);
    expect(await workspace.displayFile("file:///Main.lean")).toBe(view);
    expect(displayDocument).toHaveBeenCalledTimes(2);
    workspace.closeFile("file:///Main.lean", view);
    view.destroy();
  });
});
