import { afterEach, describe, expect, it } from "vitest";

import {
  applyLeanWorkspaceEdit,
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

function createWorkspaceClient() {
  const persisted: string[] = [];
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      renameProvider: true,
      textDocumentSync: 2,
    },
  }));
  const client = createLeanLspClient({
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
  return { client, persisted, transport };
}

describe("applyLeanWorkspaceEdit", () => {
  it("loads late targets and maps request-time edits through local changes", async () => {
    const { client, persisted, transport } = createWorkspaceClient();
    const view = createTestView(
      "def answer : Nat := helperValue + 1\n",
      lean4({ client, uri: MAIN_URI }),
    );
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.requestFile(HELPER_URI);
    const mapping = client.workspaceMapping();
    view.dispatch({ changes: { from: 0, insert: "-- local main\n" } });
    workspace.updateFile(HELPER_URI, {
      changes: { from: 0, insert: "-- local helper\n" },
    });

    const result = await applyLeanWorkspaceEdit(
      client,
      {
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
      },
      { mapping, userEvent: "rename" },
    );
    mapping.destroy();

    expect(result).toEqual({
      applied: true,
      changedUris: [MAIN_URI, HELPER_URI],
    });
    expect(view.state.doc.toString()).toContain(
      "def answer : Nat := renamedValue + 1",
    );
    expect(helper?.doc.toString()).toContain("def renamedValue : Nat := 41");
    expect(persisted).toEqual([HELPER_URI, HELPER_URI]);
    await waitFor(() => transport.notifications("textDocument/didChange").length === 1);

    view.destroy();
    client.disconnect();
  });

  it("supports versioned text document edits", async () => {
    const { client } = createWorkspaceClient();
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.requestFile(HELPER_URI);

    const result = await applyLeanWorkspaceEdit(client, {
      documentChanges: [
        {
          textDocument: { uri: HELPER_URI, version: helper!.version },
          edits: [
            {
              range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 15 },
              },
              newText: "renamedValue",
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      applied: true,
      changedUris: [HELPER_URI],
    });
    expect(helper?.doc.toString()).toContain("def renamedValue : Nat := 41");

    client.disconnect();
  });

  it("rejects stale versions and resource operations without partial edits", async () => {
    const { client } = createWorkspaceClient();
    const view = createTestView(
      "def answer : Nat := 42\n",
      lean4({ client, uri: MAIN_URI }),
    );
    await client.initializing;
    const workspace = client.workspace as LeanWorkspace;
    const helper = await workspace.requestFile(HELPER_URI);

    const stale = await applyLeanWorkspaceEdit(client, {
      documentChanges: [
        {
          textDocument: { uri: HELPER_URI, version: helper!.version + 1 },
          edits: [
            {
              range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 15 },
              },
              newText: "staleValue",
            },
          ],
        },
      ],
    });
    expect(stale).toMatchObject({
      applied: false,
      changedUris: [],
      failedChange: 0,
    });
    expect(helper?.doc.toString()).toContain("helperValue");

    const resourceOperation = await applyLeanWorkspaceEdit(client, {
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
    });
    expect(resourceOperation).toMatchObject({
      applied: false,
      changedUris: [],
      failedChange: 1,
    });
    expect(view.state.doc.toString()).toBe("def answer : Nat := 42\n");

    const invalidRange = await applyLeanWorkspaceEdit(client, {
      changes: {
        [MAIN_URI]: [
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 10 },
            },
            newText: "changed",
          },
        ],
        [HELPER_URI]: [
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 5, character: 0 },
            },
            newText: "invalid",
          },
        ],
      },
    });
    expect(invalidRange).toMatchObject({
      applied: false,
      changedUris: [],
      failedChange: 1,
    });
    expect(view.state.doc.toString()).toBe("def answer : Nat := 42\n");
    expect(helper?.doc.toString()).toContain("helperValue");

    view.destroy();
    client.disconnect();
  });

  it("clamps characters past a line end as the LSP specification requires", async () => {
    const { client, transport } = createWorkspaceClient();
    const view = createTestView(
      "def answer : Nat := 41\n",
      lean4({ client, uri: MAIN_URI }),
    );
    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);
    const workspace = client.workspace as LeanWorkspace;
    await workspace.requestFile(HELPER_URI);

    const direct = await applyLeanWorkspaceEdit(client, {
      changes: {
        [MAIN_URI]: [{
          range: { start: { line: 0, character: 20 }, end: { line: 0, character: 999 } },
          newText: "42",
        }],
      },
    });
    expect(direct).toMatchObject({ applied: true, changedUris: [MAIN_URI] });
    expect(view.state.doc.toString()).toBe("def answer : Nat := 42\n");

    // With a request-time mapping, clamp against the request-time text and
    // then map through local edits made while the request was in flight.
    const mapping = client.workspaceMapping();
    workspace.updateFile(HELPER_URI, { changes: { from: 0, insert: "-- local\n" } });
    const mapped = await applyLeanWorkspaceEdit(client, {
      changes: {
        [HELPER_URI]: [{
          range: { start: { line: 0, character: 25 }, end: { line: 0, character: 999 } },
          newText: "42",
        }],
      },
    }, { mapping });
    mapping.destroy();
    expect(mapped).toMatchObject({ applied: true, changedUris: [HELPER_URI] });
    expect(workspace.getFile(HELPER_URI)?.doc.toString()).toBe(
      "-- local\ndef helperValue : Nat := 42\n",
    );

    const pastLastLine = await applyLeanWorkspaceEdit(client, {
      changes: {
        [MAIN_URI]: [{
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
          newText: "-- appended",
        }],
      },
    });
    expect(pastLastLine).toMatchObject({ applied: false, changedUris: [] });
    expect(view.state.doc.toString()).toBe("def answer : Nat := 42\n");

    view.destroy();
    client.disconnect();
  });
});
