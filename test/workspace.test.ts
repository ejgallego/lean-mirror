import { afterEach, describe, expect, it } from "vitest";

import {
  createLeanLspClient,
  createLeanWorkspace,
  lean4,
  type LeanWorkspace,
} from "../src/index.js";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const MAIN_URI = "file:///Main.lean";
const HELPER_URI = "file:///Helper.lean";

afterEach(() => {
  document.body.innerHTML = "";
});

function createInitializedClient(workspace: ReturnType<typeof createLeanWorkspace>) {
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      definitionProvider: true,
      textDocumentSync: 2,
    },
  }));
  const client = createLeanLspClient({ workspace });
  client.connect(transport);
  return { client, transport };
}

describe("LeanWorkspace", () => {
  it("loads hidden files and keeps their content updated", async () => {
    const { client } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          if (uri === HELPER_URI) {
            return "def helperValue : Nat := 41\n";
          }
          return null;
        },
      }),
    );

    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.requestFile(HELPER_URI);
    expect(helper?.doc.toString()).toContain("helperValue");

    workspace.updateFile(HELPER_URI, {
      changes: {
        from: helper!.doc.length,
        insert: "#check helperValue\n",
      },
      userEvent: "rename",
    });

    expect(workspace.getFile(HELPER_URI)?.doc.toString()).toContain("#check helperValue");

    client.disconnect();
  });

  it("deduplicates concurrent hidden file loads", async () => {
    let loads = 0;
    const { client } = createInitializedClient(
      createLeanWorkspace({
        async loadDocument(uri) {
          if (uri !== HELPER_URI) {
            return null;
          }
          loads += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "def helperValue : Nat := 41\n";
        },
      }),
    );

    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const [left, right] = await Promise.all([
      workspace.requestFile(HELPER_URI),
      workspace.requestFile(HELPER_URI),
    ]);

    expect(left).toBe(right);
    expect(loads).toBe(1);

    client.disconnect();
  });

  it("does not synchronize cached files until an owner opens them in Lean", async () => {
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
      }),
    );
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.requestFile(HELPER_URI);
    workspace.updateFile(HELPER_URI, { changes: { from: 3, insert: "d" } });
    client.sync();
    await Promise.resolve();

    expect(helper?.doc.toString()).toBe("abcd");
    expect(transport.notifications("textDocument/didOpen")).toHaveLength(0);
    expect(transport.notifications("textDocument/didChange")).toHaveLength(0);

    const lease = await workspace.acquireServerDocument(HELPER_URI);
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);
    expect(transport.notifications("textDocument/didOpen")[0]?.params).toMatchObject({
      textDocument: {
        text: "abcd",
        uri: HELPER_URI,
      },
    });
    expect(lease?.file.version).toBe(helper?.version);

    lease?.release();
    client.disconnect();
  });

  it("can keep a hidden loaded file open and synchronized with the server", async () => {
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          if (uri === HELPER_URI) {
            return "def helperValue : Nat := 41\n";
          }
          return null;
        },
      }),
    );

    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helperLease = await workspace.acquireServerDocument(HELPER_URI);
    const helper = helperLease?.file;

    expect(helper?.serverOpen).toBe(true);
    expect(
      transport.notifications("textDocument/didOpen").some((message) => {
        const params = message.params as { textDocument?: { uri?: string } };
        return params.textDocument?.uri === HELPER_URI;
      }),
    ).toBe(true);

    workspace.updateFile(HELPER_URI, {
      changes: {
        from: helper!.doc.length,
        insert: "#check helperValue\n",
      },
    });
    client.sync();

    await waitFor(() => transport.notifications("textDocument/didChange").some((message) => {
        const params = message.params as { textDocument?: { uri?: string } };
        return params.textDocument?.uri === HELPER_URI;
      }));

    helperLease?.release();
    client.disconnect();
  });

  it("uses independent leases and flushes the final change before didClose", async () => {
    let loads = 0;
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          if (uri !== HELPER_URI) {
            return null;
          }
          loads += 1;
          return "abc";
        },
      }),
    );
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const first = await workspace.acquireServerDocument(HELPER_URI);
    const second = await workspace.acquireServerDocument(HELPER_URI);
    expect(first?.file).toBe(second?.file);
    expect(first?.file.serverOpen).toBe(true);
    expect(transport.notifications("textDocument/didOpen")).toHaveLength(1);

    workspace.updateFile(HELPER_URI, { changes: { from: 3, insert: "d" } });
    expect(first?.release()).toBe(true);
    expect(first?.release()).toBe(false);
    expect(second?.file.serverOpen).toBe(true);
    expect(transport.notifications("textDocument/didChange")).toHaveLength(0);
    expect(transport.notifications("textDocument/didClose")).toHaveLength(0);

    expect(second?.release()).toBe(true);
    await waitFor(() => transport.notifications("textDocument/didClose").length === 1);
    const change = transport.notifications("textDocument/didChange")[0]!;
    const close = transport.notifications("textDocument/didClose")[0]!;
    expect(transport.sent.indexOf(change)).toBeLessThan(transport.sent.indexOf(close));
    expect(change.params).toMatchObject({
      contentChanges: [{ text: "abcd" }],
      textDocument: { uri: HELPER_URI, version: 1 },
    });
    expect(first?.file.serverOpen).toBe(false);

    expect(await workspace.unloadDocument(HELPER_URI)).toBe("unloaded");
    expect(workspace.getFile(HELPER_URI)).toBeNull();
    expect(await workspace.unloadDocument(HELPER_URI)).toBe("not-loaded");

    const reopened = await workspace.acquireServerDocument(HELPER_URI);
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 2);
    expect(loads).toBe(2);
    expect(reopened?.file.version).toBe(2);
    reopened?.release();
    client.disconnect();
  });

  it("refuses to unload documents while a server lease or editor owns them", async () => {
    const { client } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
      }),
    );
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;

    const lease = await workspace.acquireServerDocument(HELPER_URI);
    expect(await workspace.unloadDocument(HELPER_URI)).toBe("in-use");
    lease?.release();
    expect(await workspace.unloadDocument(HELPER_URI)).toBe("unloaded");

    const view = createTestView("def main := 1\n", lean4({ client, uri: MAIN_URI }));
    expect(await workspace.unloadDocument(MAIN_URI)).toBe("in-use");
    view.destroy();
    expect(await workspace.unloadDocument(MAIN_URI)).toBe("unloaded");

    client.disconnect();
  });

  it("waits for an in-flight load before unloading its result", async () => {
    let resolveLoad!: (doc: string) => void;
    const { client } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          if (uri !== HELPER_URI) {
            return null;
          }
          return new Promise<string>((resolve) => {
            resolveLoad = resolve;
          });
        },
      }),
    );
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;

    const loading = workspace.requestFile(HELPER_URI);
    const unloading = workspace.unloadDocument(HELPER_URI);
    resolveLoad("abc");

    expect((await loading)?.doc.toString()).toBe("abc");
    expect(await unloading).toBe("unloaded");
    expect(workspace.getFile(HELPER_URI)).toBeNull();

    client.disconnect();
  });

  it("waits for host persistence before unloading changed cached text", async () => {
    let finishPersistence!: () => void;
    const { client } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
        onDocumentChange() {
          return new Promise<void>((resolve) => {
            finishPersistence = resolve;
          });
        },
      }),
    );
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;
    await workspace.requestFile(HELPER_URI);
    workspace.updateFile(HELPER_URI, { changes: { from: 3, insert: "d" } });

    let unloadResult: string | null = null;
    const unloading = workspace.unloadDocument(HELPER_URI).then((result) => {
      unloadResult = result;
      return result;
    });
    const concurrentUnload = workspace.unloadDocument(HELPER_URI);
    await Promise.resolve();
    expect(unloadResult).toBeNull();

    finishPersistence();
    expect((await Promise.all([unloading, concurrentUnload])).sort()).toEqual([
      "not-loaded",
      "unloaded",
    ]);
    expect(workspace.getFile(HELPER_URI)).toBeNull();

    client.disconnect();
  });

  it("coalesces hidden edits into one correctly versioned document change", async () => {
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
      }),
    );
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helperLease = await workspace.acquireServerDocument(HELPER_URI);
    const helper = helperLease?.file;
    expect(helper?.version).toBe(0);

    workspace.updateFile(HELPER_URI, { changes: { from: 3, insert: "1" } });
    workspace.updateFile(HELPER_URI, { changes: { from: 4, insert: "2" } });
    expect(helper?.doc.toString()).toBe("abc12");
    expect(helper?.version).toBe(0);

    client.sync();

    await waitFor(() => transport.notifications("textDocument/didChange").length === 1);
    const changes = transport.notifications("textDocument/didChange");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.params).toMatchObject({
      contentChanges: [{ text: "abc12" }],
      textDocument: { uri: HELPER_URI, version: 1 },
    });
    expect(helper?.version).toBe(1);

    helperLease?.release();
    client.disconnect();
  });

  it("synchronizes successive hidden-document edit batches", async () => {
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
      }),
    );
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helperLease = await workspace.acquireServerDocument(HELPER_URI);
    const helper = helperLease?.file;
    workspace.updateFile(HELPER_URI, { changes: { from: 3, insert: "d" } });
    client.sync();
    await waitFor(() => transport.notifications("textDocument/didChange").length === 1);

    workspace.updateFile(HELPER_URI, {
      changes: { from: 0, to: helper!.doc.length, insert: "abc" },
    });
    expect(helper?.doc.toString()).toBe("abc");
    client.sync();
    await waitFor(() => transport.notifications("textDocument/didChange").length === 2);

    expect(transport.notifications("textDocument/didChange")[1]?.params).toMatchObject({
      contentChanges: [{ text: "abc" }],
      textDocument: { uri: HELPER_URI, version: 2 },
    });
    expect(helper?.version).toBe(2);

    helperLease?.release();
    client.disconnect();
  });

  it("does not advance a hidden document version for a no-op update", async () => {
    let changes = 0;
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "abc" : null;
        },
        onDocumentChange() {
          changes += 1;
        },
      }),
    );
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helperLease = await workspace.acquireServerDocument(HELPER_URI);
    const helper = helperLease?.file;
    const version = helper!.version;
    workspace.updateFile(HELPER_URI, { changes: { from: 1, to: 1, insert: "" } });
    client.sync();

    expect(helper?.version).toBe(version);
    expect(changes).toBe(0);
    expect(transport.notifications("textDocument/didChange")).toHaveLength(0);

    helperLease?.release();
    client.disconnect();
  });

  it("rejects multiple editor views for the same URI", async () => {
    const { client } = createInitializedClient(createLeanWorkspace());
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;
    const first = createTestView("#check Nat", []);
    const second = createTestView("#check Nat", []);

    workspace.openFile(MAIN_URI, "lean4", first);
    expect(() => workspace.openFile(MAIN_URI, "lean4", second)).toThrow(/multiple editor views/);

    workspace.closeFile(MAIN_URI, first);
    first.destroy();
    second.destroy();
    client.disconnect();
  });

  it("does not send duplicate didOpen when a server-open file is displayed", async () => {
    let client!: ReturnType<typeof createLeanLspClient>;
    let helperView = null as ReturnType<typeof createTestView> | null;

    const workspaceFactory = createLeanWorkspace({
      loadDocument(uri) {
        if (uri === HELPER_URI) {
          return "def helperValue : Nat := 41\n";
        }
        return null;
      },
      async displayDocument() {
        helperView = createTestView("def helperValue : Nat := 41\n", lean4({ client, uri: HELPER_URI }));
        return helperView;
      },
    });

    const initialized = createInitializedClient(workspaceFactory);
    client = initialized.client;
    const transport = initialized.transport;
    const view = createTestView("import Helper\n#check helperValue\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helperLease = await workspace.acquireServerDocument(HELPER_URI);
    const opensBefore = transport.notifications("textDocument/didOpen").length;
    await workspace.displayFile(HELPER_URI);

    expect(transport.notifications("textDocument/didOpen")).toHaveLength(opensBefore);

    helperView?.destroy();
    helperLease?.release();
    view.destroy();
    client.disconnect();
  });

  it("flushes a closing editor while a server lease keeps the document open", async () => {
    const { client, transport } = createInitializedClient(
      createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "def helperValue := 1\n" : null;
        },
      }),
    );
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;
    const lease = await workspace.acquireServerDocument(HELPER_URI);
    const view = createTestView(
      "def helperValue := 1\n",
      lean4({ client, uri: HELPER_URI }),
    );

    view.dispatch({
      changes: { from: "def helperValue := ".length, to: "def helperValue := 1".length, insert: "2" },
    });
    view.destroy();
    await waitFor(() => transport.notifications("textDocument/didChange").length === 1);

    expect(lease?.file.doc.toString()).toBe("def helperValue := 2\n");
    expect(transport.notifications("textDocument/didClose")).toHaveLength(0);

    lease?.release();
    await waitFor(() => transport.notifications("textDocument/didClose").length === 1);
    client.disconnect();
  });

  it("reopens unsynchronized editor text after a direct client reconnect", async () => {
    const initialized = createInitializedClient(createLeanWorkspace());
    const { client } = initialized;
    const view = createTestView("def value := 1\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;

    view.dispatch({
      changes: { from: "def value := ".length, to: "def value := 1".length, insert: "2" },
    });
    client.disconnect();

    const workspace = client.workspace as LeanWorkspace;
    expect(workspace.getFile(MAIN_URI)?.doc.toString()).toBe("def value := 2\n");
    view.dispatch({
      changes: { from: "def value := ".length, to: "def value := 2".length, insert: "3" },
    });
    client.sync();
    await Promise.resolve();
    expect(initialized.transport.notifications("textDocument/didChange")).toHaveLength(0);
    expect(workspace.getFile(MAIN_URI)?.doc.toString()).toBe("def value := 3\n");

    const nextTransport = new MockTransport();
    nextTransport.onRequest("initialize", () => ({
      capabilities: { textDocumentSync: 2 },
    }));
    client.connect(nextTransport);
    await client.initializing;
    await waitFor(() => nextTransport.notifications("textDocument/didOpen").length === 1);

    expect(nextTransport.notifications("textDocument/didOpen")[0]?.params).toMatchObject({
      textDocument: {
        text: "def value := 3\n",
        uri: MAIN_URI,
        version: 2,
      },
    });

    view.destroy();
    client.disconnect();
  });

  it("delegates displayFile to the host when a target file has no open view", async () => {
    let client!: ReturnType<typeof createLeanLspClient>;
    let displayCount = 0;
    let helperView = null as ReturnType<typeof createTestView> | null;

    const workspaceFactory = createLeanWorkspace({
      loadDocument(uri) {
        if (uri === HELPER_URI) {
          return "def helperValue : Nat := 41\n";
        }
        return null;
      },
      async displayDocument() {
        displayCount += 1;
        helperView = createTestView("def helperValue : Nat := 41\n", lean4({ client, uri: HELPER_URI }));
        return helperView;
      },
    });

    ({ client } = createInitializedClient(workspaceFactory));
    const view = createTestView("import Helper\n#check helperValue\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;

    const target = await (client.workspace as LeanWorkspace).displayFile(HELPER_URI);
    await waitFor(() => displayCount === 1);

    expect(target).toBe(helperView);
    expect(displayCount).toBe(1);

    helperView?.destroy();
    view.destroy();
    client.disconnect();
  });
});
