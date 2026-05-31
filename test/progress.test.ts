import { afterEach, describe, expect, it } from "vitest";

import { LSPClient } from "../src/codemirror.js";
import {
  createLeanLspClient,
  createLeanWorkspace,
  lean4,
  leanFileProgress,
  LeanFileProgressKind,
  leanFileProgressMethod,
  type LeanLspClientConfig,
  type LeanFileProgressProcessingInfo,
  type LeanWorkspace,
} from "../src/index.js";
import { workDoneProgress } from "../src/progress.js";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const MAIN_URI = "file:///Main.lean";
const HELPER_URI = "file:///Helper.lean";

afterEach(() => {
  document.body.innerHTML = "";
});

function createInitializedLeanClient(config: LeanLspClientConfig = {}) {
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      textDocumentSync: 2,
    },
  }));
  const client = createLeanLspClient(config);
  client.connect(transport);
  return { client, transport };
}

function progressParams(
  uri: string,
  version: number,
  processing: readonly LeanFileProgressProcessingInfo[] = [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    },
  ],
) {
  return {
    processing,
    textDocument: {
      uri,
      version,
    },
  };
}

function openedVersion(transport: MockTransport, uri: string): number {
  const open = transport.notifications("textDocument/didOpen").find((message) => {
    const params = message.params as { textDocument?: { uri?: string } };
    return params.textDocument?.uri === uri;
  });
  if (!open) {
    throw new Error(`Missing didOpen for ${uri}.`);
  }
  return (open.params as { textDocument: { version: number } }).textDocument.version;
}

describe("Lean file progress", () => {
  it("tracks progress for the active Lean document", async () => {
    const progress = leanFileProgress();
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
    });
    const view = createTestView("def x := 1\n", lean4({ client, uri: MAIN_URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const version = openedVersion(transport, MAIN_URI);
    transport.emitNotification(leanFileProgressMethod, progressParams(MAIN_URI, version));

    await waitFor(() => progress.store.get(MAIN_URI)?.processing.length === 1);
    expect(progress.store.get(MAIN_URI)).toMatchObject({
      hasFatalError: false,
      isProcessing: true,
      uri: MAIN_URI,
      version,
    });

    view.destroy();
    client.disconnect();
  });

  it("tracks progress for hidden workspace documents", async () => {
    const progress = leanFileProgress();
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "def helperValue : Nat := 41\n" : null;
        },
      }),
    });
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.openServerDocument(HELPER_URI);
    expect(helper).not.toBeNull();
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    transport.emitNotification(leanFileProgressMethod, progressParams(HELPER_URI, helper!.version));

    await waitFor(() => progress.store.get(HELPER_URI)?.processing.length === 1);
    expect(progress.store.get(HELPER_URI)?.uri).toBe(HELPER_URI);

    client.disconnect();
  });

  it("clears progress when Lean reports an empty processing array", async () => {
    const progress = leanFileProgress();
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
    });
    const view = createTestView("def x := 1\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const version = openedVersion(transport, MAIN_URI);
    transport.emitNotification(leanFileProgressMethod, progressParams(MAIN_URI, version));
    await waitFor(() => progress.store.get(MAIN_URI) !== null);

    transport.emitNotification(leanFileProgressMethod, progressParams(MAIN_URI, version, []));
    await waitFor(() => progress.store.get(MAIN_URI) === null);

    view.destroy();
    client.disconnect();
  });

  it("ignores stale progress versions by default", async () => {
    const updates: string[] = [];
    const progress = leanFileProgress({
      onUpdate(update) {
        updates.push(`${update.uri}:${update.state?.version ?? "clear"}`);
      },
    });
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          return uri === HELPER_URI ? "def helperValue : Nat := 41\n" : null;
        },
      }),
    });
    await client.initializing;

    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.openServerDocument(HELPER_URI);
    workspace.updateFile(HELPER_URI, {
      changes: {
        from: helper!.doc.length,
        insert: "#check helperValue\n",
      },
    });

    transport.emitNotification(leanFileProgressMethod, progressParams(HELPER_URI, helper!.version - 1));

    expect(progress.store.get(HELPER_URI)).toBeNull();
    expect(updates).toEqual([]);

    client.disconnect();
  });

  it("keeps fatal-error progress items visible to host applications", async () => {
    const progress = leanFileProgress();
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
    });
    const view = createTestView("def x := 1\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const version = openedVersion(transport, MAIN_URI);
    transport.emitNotification(
      leanFileProgressMethod,
      progressParams(MAIN_URI, version, [
        {
          kind: LeanFileProgressKind.FatalError,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
        },
      ]),
    );

    await waitFor(() => progress.store.get(MAIN_URI)?.hasFatalError === true);
    expect(progress.store.get(MAIN_URI)?.processing[0]?.kind).toBe(LeanFileProgressKind.FatalError);

    view.destroy();
    client.disconnect();
  });

  it("clears tracked progress on disconnect", async () => {
    const progress = leanFileProgress();
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
    });
    const view = createTestView("def x := 1\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    transport.emitNotification(leanFileProgressMethod, progressParams(MAIN_URI, openedVersion(transport, MAIN_URI)));
    await waitFor(() => progress.store.entries().length === 1);

    client.disconnect();
    expect(progress.store.entries()).toEqual([]);

    view.destroy();
  });

  it("composes with custom notification handlers without swallowing them", async () => {
    const progress = leanFileProgress();
    const seen: unknown[] = [];
    const { client, transport } = createInitializedLeanClient({
      extensions: [progress],
      notificationHandlers: {
        [leanFileProgressMethod]: (_client, params) => {
          seen.push(params);
          return false;
        },
      },
    });
    const view = createTestView("def x := 1\n", lean4({ client, uri: MAIN_URI }));
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    transport.emitNotification(leanFileProgressMethod, progressParams(MAIN_URI, openedVersion(transport, MAIN_URI)));

    await waitFor(() => progress.store.get(MAIN_URI) !== null);
    expect(seen).toHaveLength(1);

    view.destroy();
    client.disconnect();
  });
});

describe("WorkDoneProgress", () => {
  it("handles server-created progress requests and standard $/progress notifications", async () => {
    const updates: string[] = [];
    const progress = workDoneProgress({
      onUpdate(update) {
        updates.push(update.kind);
      },
    });
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({
      capabilities: {},
    }));
    const client = new LSPClient({
      extensions: [progress],
      rootUri: "file:///workspace",
    });
    client.connect(progress.wrapTransport(transport));
    await client.initializing;

    const initialize = transport.requests("initialize")[0];
    expect(initialize?.params).toMatchObject({
      capabilities: {
        window: {
          workDoneProgress: true,
        },
      },
    });

    transport.emitRequest("window/workDoneProgress/create", {
      token: "rustAnalyzer/Indexing",
    }, "progress-1");

    await waitFor(() => transport.sent.some((message) => message.id === "progress-1" && "result" in message));
    expect(progress.store.hasCreatedToken("rustAnalyzer/Indexing")).toBe(true);

    transport.emitNotification("$/progress", {
      token: "rustAnalyzer/Indexing",
      value: {
        kind: "begin",
        title: "Indexing",
        percentage: 0,
      },
    });
    await waitFor(() => progress.store.get("rustAnalyzer/Indexing")?.title === "Indexing");

    transport.emitNotification("$/progress", {
      token: "rustAnalyzer/Indexing",
      value: {
        kind: "report",
        message: "2/4 crates",
        percentage: 50,
      },
    });
    await waitFor(() => progress.store.get("rustAnalyzer/Indexing")?.percentage === 50);
    expect(progress.store.get("rustAnalyzer/Indexing")?.message).toBe("2/4 crates");

    transport.emitNotification("$/progress", {
      token: "rustAnalyzer/Indexing",
      value: {
        kind: "end",
        message: "done",
      },
    });
    await waitFor(() => progress.store.get("rustAnalyzer/Indexing") === null);
    expect(updates).toEqual(["create", "begin", "report", "end"]);

    client.disconnect();
  });

  it("does not forward handled WorkDoneProgress create requests to the LSP client", async () => {
    const progress = workDoneProgress();
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({
      capabilities: {},
    }));
    const client = new LSPClient({
      extensions: [progress],
    });
    client.connect(progress.wrapTransport(transport));
    await client.initializing;

    transport.emitRequest("window/workDoneProgress/create", {
      token: "rustAnalyzer/Flycheck",
    }, 100);

    await waitFor(() => transport.sent.some((message) => message.id === 100 && "result" in message));
    expect(transport.sent.some((message) => message.id === 100 && "error" in message)).toBe(false);

    client.disconnect();
  });
});
