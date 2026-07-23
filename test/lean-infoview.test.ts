import type { EditorApi } from "@leanprover/infoview";
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
} from "../demo/src/leanInfoview.js";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const MAIN_URI = "file:///Main.lean";
const HELPER_URI = "file:///Helper.lean";

const infoviewMock = vi.hoisted(() => ({
  clientNotifications: [] as Array<{ method: string; params: unknown }>,
  editorApi: null as unknown,
}));

vi.mock("@leanprover/infoview", () => {
  const complete = async (): Promise<void> => {};
  return {
    defaultInfoviewConfig: {},
    renderInfoview(editorApi: unknown) {
      infoviewMock.editorApi = editorApi;
      return {
        changedCursorLocation: complete,
        changedInfoviewConfig: complete,
        clickedContextMenu: complete,
        getInfoviewHtml: async () => "",
        gotServerNotification: complete,
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
  infoviewMock.clientNotifications.length = 0;
  infoviewMock.editorApi = null;
  document.body.innerHTML = "";
});

async function createHarness() {
  const persisted: string[] = [];
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      textDocumentSync: 2,
    },
  }));
  let host: LeanInfoviewHost | null = null;
  const notificationExtension = leanInfoviewClientNotifications(() => host);
  const client = createLeanLspClient({
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
  const container = document.createElement("div");
  document.body.appendChild(container);
  host = createLeanInfoviewHost({
    client: () => client,
    container,
    currentLanguageId: () => "lean4",
    currentUri: () => MAIN_URI,
    currentView: () => view,
    log() {},
    requestRestart() {},
    workspace: () => client.workspace as LeanWorkspace,
  });

  await client.initializing;
  await waitFor(() => infoviewMock.editorApi !== null);
  return {
    client,
    editorApi: infoviewMock.editorApi as EditorApi,
    host,
    notificationExtension,
    persisted,
    transport,
    view,
    workspace: client.workspace as LeanWorkspace,
  };
}

describe("Lean infoview workspace edits", () => {
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
});
