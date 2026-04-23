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
    const helper = await workspace.openServerDocument(HELPER_URI);

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
    await workspace.openServerDocument(HELPER_URI);
    const opensBefore = transport.notifications("textDocument/didOpen").length;
    await workspace.displayFile(HELPER_URI);

    expect(transport.notifications("textDocument/didOpen")).toHaveLength(opensBefore);

    helperView?.destroy();
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
      async displayDocument(uri) {
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
