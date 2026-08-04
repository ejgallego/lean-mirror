import type { EditorApi } from "@leanprover/infoview";
import { renderEditorPlatformWorkspaceShell } from "@leanprover/editor-platform";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLeanLspClient,
  createLeanWorkspace,
  lean4,
  type LeanWorkspace,
} from "../src/index.js";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const MAIN_URI = "file:///Main.lean";
const HELPER_URI = "file:///Helper.lean";

const infoviewMock = vi.hoisted(() => ({
  clientNotifications: [] as Array<{ method: string; params: unknown }>,
  editorApi: null as unknown,
  serverNotifications: [] as Array<{ method: string; params: unknown }>,
}));

vi.mock("@leanprover/infoview", () => {
  const complete = async (): Promise<void> => {};
  return {
    defaultInfoviewConfig: {},
    renderInfoview(editorApi: unknown, container: HTMLElement) {
      infoviewMock.editorApi = editorApi;
      const mounted = document.createElement("div");
      mounted.dataset.leanInfoview = "mounted";
      container.replaceChildren(mounted);
      return {
        changedCursorLocation: complete,
        changedInfoviewConfig: complete,
        clickedContextMenu: complete,
        getInfoviewHtml: async () => "",
        async gotServerNotification(method: string, params: unknown) {
          infoviewMock.serverNotifications.push({ method, params });
        },
        initialize: complete,
        requestedAction: complete,
        runTestScript: complete,
        async sentClientNotification(method: string, params: unknown) {
          infoviewMock.clientNotifications.push({ method, params });
        },
        serverRestarted: complete,
        serverStopped: complete,
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  infoviewMock.clientNotifications.length = 0;
  infoviewMock.editorApi = null;
  infoviewMock.serverNotifications.length = 0;
  document.body.innerHTML = "";
});

async function createHarness(container: HTMLElement = document.createElement("div")) {
  const displayedViews = new Map<string, ReturnType<typeof createTestView>>();
  const persisted: string[] = [];
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      textDocumentSync: 2,
    },
  }));
  let host: LeanInfoviewHost | null = null;
  const notificationExtension = leanInfoviewClientNotifications(() => host);
  let client!: ReturnType<typeof createLeanLspClient>;
  client = createLeanLspClient({
    extensions: [notificationExtension],
    features: {
      completion: false,
      definitionKeymap: false,
      diagnostics: false,
      formatKeymap: false,
      hover: false,
      referencesKeymap: false,
      renameKeymap: false,
      semanticTokens: false,
      signatureHelp: false,
    },
    workspace: createLeanWorkspace({
      displayDocument(uri, workspace) {
        const file = workspace.getFile(uri);
        if (!file) {
          return null;
        }
        const opened = createTestView(
          file.doc.toString(),
          lean4({ client, uri }),
        );
        displayedViews.set(uri, opened);
        return opened;
      },
      loadDocument(uri) {
        return uri === HELPER_URI ? "def helperValue : Nat := 41\n" : null;
      },
      onDocumentChange(uri) {
        persisted.push(uri);
      },
    }),
  });
  client.connect(transport);
  const view = createTestView(
    "def answer : Nat := helperValue + 1\n",
    lean4({ client, uri: MAIN_URI }),
  );
  if (!container.isConnected) {
    document.body.appendChild(container);
  }
  host = createLeanInfoviewHost({
    client: () => client,
    container,
    currentLanguageId: () => "lean4",
    currentUri: () => MAIN_URI,
    currentView: () => view,
    requestRestart() {},
    workspace: () => client.workspace as LeanWorkspace,
  });

  await client.initializing;
  await waitFor(() => infoviewMock.editorApi !== null);
  return {
    client,
    container,
    displayedViews,
    editorApi: infoviewMock.editorApi as EditorApi,
    host,
    notificationExtension,
    persisted,
    transport,
    view,
    workspace: client.workspace as LeanWorkspace,
  };
}

describe("Lean infoview host", () => {
  it("uses the core edit boundary for displayed and hidden documents", async () => {
    const harness = await createHarness();

    await harness.editorApi.applyEdit({
      changes: {
        [MAIN_URI]: [
          {
            range: {
              start: { line: 0, character: 20 },
              end: { line: 0, character: 31 },
            },
            newText: "renamedValue",
          },
        ],
        [HELPER_URI]: [
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 15 },
            },
            newText: "renamedValue",
          },
        ],
      },
    });

    expect(harness.view.state.doc.toString()).toContain(
      "def answer : Nat := renamedValue + 1",
    );
    expect(harness.workspace.getFile(HELPER_URI)?.doc.toString()).toContain(
      "def renamedValue : Nat := 41",
    );
    expect(harness.persisted).toEqual([HELPER_URI]);
    await waitFor(
      () => harness.transport.notifications("textDocument/didChange").length === 1,
    );

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("surfaces an atomic rejection instead of partially applying resource edits", async () => {
    const harness = await createHarness();
    const before = harness.view.state.doc.toString();

    await expect(
      harness.editorApi.applyEdit({
        documentChanges: [
          {
            textDocument: { uri: MAIN_URI, version: null },
            edits: [
              {
                range: {
                  start: { line: 0, character: 4 },
                  end: { line: 0, character: 10 },
                },
                newText: "changed",
              },
            ],
          },
          { kind: "create", uri: "file:///Created.lean" },
        ],
      }),
    ).rejects.toThrow(/Unsupported workspace resource operation/);
    expect(harness.view.state.doc.toString()).toBe(before);
    expect(harness.transport.notifications("textDocument/didChange")).toHaveLength(0);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("opens cross-file locations through the host workspace", async () => {
    const harness = await createHarness();

    await harness.editorApi.showDocument({
      external: false,
      selection: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 15 },
      },
      takeFocus: true,
      uri: HELPER_URI,
    });

    const helper = harness.displayedViews.get(HELPER_URI);
    expect(helper?.state.doc.toString()).toBe("def helperValue : Nat := 41\n");
    expect(helper?.state.sliceDoc(
      helper.state.selection.main.from,
      helper.state.selection.main.to,
    )).toBe("helperValue");
    expect(helper?.hasFocus).toBe(true);

    harness.host.dispose();
    helper?.destroy();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("forwards subscribed client notifications through the generation extension", async () => {
    const harness = await createHarness();
    const originalNotification = harness.client.notification;
    await harness.editorApi.subscribeClientNotifications("$/lean/subscribed");

    harness.client.notification("$/lean/ignored", { value: 0 });
    harness.client.notification("$/lean/subscribed", { value: 1 });
    await waitFor(() => infoviewMock.clientNotifications.length === 1);

    expect(infoviewMock.clientNotifications).toEqual([
      {
        method: "$/lean/subscribed",
        params: { value: 1 },
      },
    ]);
    expect(harness.client.notification).toBe(originalNotification);

    harness.notificationExtension.onSessionDisconnect?.(harness.client);
    harness.client.notification("$/lean/subscribed", { value: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(infoviewMock.clientNotifications).toHaveLength(1);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("forwards only subscribed server notifications", async () => {
    const harness = await createHarness();
    await harness.editorApi.subscribeServerNotifications("$/lean/subscribed");

    harness.host.forwardServerNotification("$/lean/ignored", { value: 0 });
    harness.host.forwardServerNotification("$/lean/subscribed", { value: 1 });
    await waitFor(() => infoviewMock.serverNotifications.length === 1);

    expect(infoviewMock.serverNotifications).toEqual([
      {
        method: "$/lean/subscribed",
        params: { value: 1 },
      },
    ]);

    await harness.editorApi.unsubscribeServerNotifications("$/lean/subscribed");
    harness.host.forwardServerNotification("$/lean/subscribed", { value: 2 });
    await Promise.resolve();
    expect(infoviewMock.serverNotifications).toHaveLength(1);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("settles aborted RPC requests before the disconnected client times out", async () => {
    const harness = await createHarness();
    const pending = new Promise<never>(() => undefined);
    harness.transport.onRequest("$/lean/rpc/call", () => pending);
    const abortController = new AbortController();
    const params = { method: "Lean.Widget.getInteractiveGoals" };

    const request = harness.editorApi.sendClientRequest(
      MAIN_URI,
      "$/lean/rpc/call",
      params,
      { abortSignal: abortController.signal },
    );
    await waitFor(() => harness.transport.requests("$/lean/rpc/call").length === 1);
    abortController.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => harness.transport.notifications("$/cancelRequest").length === 1);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("aborts a pending RPC session connection when the server stops", async () => {
    const harness = await createHarness();
    harness.transport.onRequest(
      "$/lean/rpc/connect",
      () => new Promise<never>(() => undefined),
    );

    const session = harness.editorApi.createRpcSession(MAIN_URI);
    await waitFor(() => harness.transport.requests("$/lean/rpc/connect").length === 1);
    harness.host.serverStopped({ message: "Lean stopped.", reason: "test" });

    await expect(session).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => harness.transport.notifications("$/cancelRequest").length === 1);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("owns Lean RPC keep-alive timers until close or host teardown", async () => {
    const harness = await createHarness();
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    harness.transport.onRequest("$/lean/rpc/connect", () => ({
      sessionId: "rpc-session",
    }));

    const sessionId = await harness.editorApi.createRpcSession(MAIN_URI);
    expect(sessionId).toBe("rpc-session");
    expect(harness.transport.requests("$/lean/rpc/connect")[0]?.params).toEqual({
      uri: MAIN_URI,
    });

    const keepAlive = setInterval.mock.calls[0]?.[0];
    expect(typeof keepAlive).toBe("function");
    if (typeof keepAlive === "function") {
      keepAlive();
    }
    await waitFor(
      () => harness.transport.notifications("$/lean/rpc/keepAlive").length === 1,
    );
    expect(harness.transport.notifications("$/lean/rpc/keepAlive")[0]?.params).toEqual({
      sessionId,
      uri: MAIN_URI,
    });

    const timer = setInterval.mock.results[0]?.value;
    await harness.editorApi.closeRpcSession(sessionId);
    expect(clearInterval).toHaveBeenCalledWith(timer);

    await harness.editorApi.createRpcSession(MAIN_URI);
    const secondTimer = setInterval.mock.results[1]?.value;
    harness.host.serverStopped({
      message: "Lean stopped.",
      reason: "test",
    });
    expect(clearInterval).toHaveBeenCalledWith(secondTimer);

    harness.host.dispose();
    harness.view.destroy();
    harness.client.disconnect();
  });

  it("mounts into the outer shell information slot", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const shell = renderEditorPlatformWorkspaceShell(root, {
      labels: {
        infoTitle: "Lean InfoView",
      },
    });
    const harness = await createHarness(shell.infoHost as HTMLElement);

    expect(
      (shell.infoHost as HTMLElement).querySelector("[data-lean-infoview='mounted']"),
    ).not.toBeNull();

    harness.host.dispose();
    expect((shell.infoHost as HTMLElement).children).toHaveLength(0);
    harness.view.destroy();
    harness.client.disconnect();
  });
});
