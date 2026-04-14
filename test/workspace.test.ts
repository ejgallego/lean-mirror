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

    const view = createTestView("import Helper\n#check helperValue\n", lean4({ client, uri: MAIN_URI }));
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
