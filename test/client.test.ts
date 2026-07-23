import { CompletionContext } from "@codemirror/autocomplete";
import { diagnosticCount } from "@codemirror/lint";
import { serverCompletionSource } from "@codemirror/lsp-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  findReferences,
  formatDocument,
  LSPPlugin,
  renameSymbol,
} from "../src/codemirror.js";
import {
  createLeanEditorSession,
  createLeanLspClient,
  createLeanWorkspace,
  lean4,
  leanJumpToDefinition,
  leanLspExtensions,
  leanRenameSymbol,
  type LeanWorkspace,
} from "../src/index.js";
import { createTestView, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const URI = "file:///Test.lean";

afterEach(() => {
  document.body.innerHTML = "";
});

function createInitializedClient(transport: MockTransport) {
  transport.onRequest("initialize", () => ({
    capabilities: {
      completionProvider: { triggerCharacters: ["."] },
      documentFormattingProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      renameProvider: true,
      textDocumentSync: 2,
    },
  }));
  const client = createLeanLspClient();
  client.connect(transport);
  return client;
}

describe("leanLspExtensions", () => {
  it("composes Lean-aware navigation and rename without an unsupported formatter", () => {
    expect(leanLspExtensions()).toHaveLength(7);
  });

  it("allows custom Lean servers to opt into the formatting keymap", () => {
    expect(leanLspExtensions({ formatKeymap: true })).toHaveLength(8);
  });
});

describe("lean4", () => {
  it("rejects ambiguous direct-client and session ownership", () => {
    expect(() => lean4({
      client: createLeanLspClient(),
      session: createLeanEditorSession(),
      uri: URI,
    })).toThrow(/either a client or a session/);
  });

  it("opens, syncs, and closes a document through the official LSP plugin", async () => {
    const transport = new MockTransport();
    const client = createInitializedClient(transport);
    const view = createTestView("def x := 1", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const open = transport.notifications("textDocument/didOpen")[0];
    expect(open?.params).toMatchObject({
      textDocument: {
        uri: URI,
        languageId: "lean4",
        text: "def x := 1",
      },
    });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n#check x" } });
    await waitFor(() => transport.notifications("textDocument/didChange").length === 1, 2_000);

    view.destroy();
    await waitFor(() => transport.notifications("textDocument/didClose").length === 1);

    client.disconnect();
  });

  it("renders server diagnostics via the official diagnostics extension", async () => {
    const transport = new MockTransport();
    const client = createInitializedClient(transport);
    const view = createTestView("theorem demo : True := by\n  trivial\n", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const open = transport.notifications("textDocument/didOpen")[0];
    const version = (open?.params as { textDocument: { version: number } }).textDocument.version;

    transport.emitNotification("textDocument/publishDiagnostics", {
      uri: URI,
      version,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 7 },
          },
          severity: 1,
          message: "Synthetic test diagnostic",
        },
      ],
    });

    await waitFor(() => diagnosticCount(view.state) === 1);

    view.destroy();
    client.disconnect();
  });

  it("requests completions through the official server completion source", async () => {
    const transport = new MockTransport();
    transport.onRequest("textDocument/completion", () => ({
      isIncomplete: false,
      items: [
        {
          label: "Nat.succ",
          kind: 3,
          detail: "Nat -> Nat",
        },
      ],
    }));
    const client = createInitializedClient(transport);
    const view = createTestView("Nat.s", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const result = await serverCompletionSource(
      new CompletionContext(view.state, view.state.doc.length, true, view),
    );

    expect(result).not.toBeNull();
    expect(result?.options.some((option) => option.label === "Nat.succ")).toBe(true);

    view.destroy();
    client.disconnect();
  });

  it("sends hover requests with Lean document positions", async () => {
    const transport = new MockTransport();
    let requested: unknown = null;
    transport.onRequest("textDocument/hover", (params) => {
      requested = params;
      return {
        contents: {
          kind: "markdown",
          value: "**Nat.succ**",
        },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
      };
    });
    const client = createInitializedClient(transport);
    const view = createTestView("Nat.succ", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    const plugin = LSPPlugin.get(view);
    const result = await client.request("textDocument/hover", {
      position: plugin!.toPosition(4),
      textDocument: { uri: URI },
    });

    expect(requested).toMatchObject({
      position: { line: 0, character: 4 },
      textDocument: { uri: URI },
    });
    expect(result).toMatchObject({
      contents: {
        value: "**Nat.succ**",
      },
    });

    view.destroy();
    client.disconnect();
  });

  it("applies formatting edits returned by the server", async () => {
    const transport = new MockTransport();
    transport.onRequest("textDocument/formatting", () => [
      {
        newText: "def x := 1\n",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      },
    ]);
    const client = createInitializedClient(transport);
    const view = createTestView("def   x:=  1", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    expect(formatDocument(view)).toBe(true);
    await waitFor(() => view.state.doc.toString() === "def x := 1\n");

    view.destroy();
    client.disconnect();
  });

  it("applies workspace edits from rename", async () => {
    const transport = new MockTransport();
    transport.onRequest("textDocument/rename", (params) => {
      expect(params).toMatchObject({
        newName: "bar",
        textDocument: { uri: URI },
      });
      return {
        changes: {
          [URI]: [
            {
              newText: "bar",
              range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 7 },
              },
            },
            {
              newText: "bar",
              range: {
                start: { line: 1, character: 7 },
                end: { line: 1, character: 10 },
              },
            },
          ],
        },
      };
    });
    const client = createInitializedClient(transport);
    const view = createTestView("def foo := 1\n#check foo", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    view.dispatch({ selection: { anchor: 5 } });
    expect(renameSymbol(view)).toBe(true);
    await waitFor(() => !!view.dom.querySelector(".cm-panel form"));
    const form = view.dom.querySelector<HTMLFormElement>(".cm-panel form")!;
    form.querySelector("input")!.value = "bar";
    form.requestSubmit();

    await waitFor(() => view.state.doc.toString().includes("def bar"));
    expect(view.state.doc.toString()).toBe("def bar := 1\n#check bar");

    view.destroy();
    client.disconnect();
  });

  it("shows references returned by the server", async () => {
    const transport = new MockTransport();
    transport.onRequest("textDocument/references", () => [
      {
        uri: URI,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 7 },
        },
      },
    ]);
    const client = createInitializedClient(transport);
    const view = createTestView("def foo := 1\n", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 1);

    expect(findReferences(view)).toBe(true);
    await waitFor(() => !!view.dom.querySelector(".cm-lsp-reference-panel"));
    expect(view.dom.querySelector(".cm-lsp-reference-panel")?.textContent).toContain("foo");

    view.destroy();
    client.disconnect();
  });

  it("shows references from files loaded after the request started", async () => {
    const helperUri = "file:///Helper.lean";
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({
      capabilities: {
        referencesProvider: true,
        textDocumentSync: 2,
      },
    }));
    transport.onRequest("textDocument/references", () => [
      {
        uri: helperUri,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 15 },
        },
      },
    ]);
    const client = createLeanLspClient({
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          return uri === helperUri ? "def helperValue : Nat := 41\n" : null;
        },
      }),
    });
    client.connect(transport);
    const view = createTestView(
      "#check helperValue\n",
      lean4({ client, uri: URI }),
    );

    await client.initializing;
    expect(findReferences(view)).toBe(true);
    await waitFor(() => !!view.dom.querySelector(".cm-lsp-reference-panel"));
    expect(view.dom.querySelector(".cm-lsp-reference-panel")?.textContent).toContain(
      "helperValue",
    );

    view.destroy();
    client.disconnect();
  });

  it("navigates LocationLink responses into host-loaded files", async () => {
    const helperUri = "file:///Helper.lean";
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({
      capabilities: {
        definitionProvider: true,
        textDocumentSync: 2,
      },
    }));
    transport.onRequest("textDocument/definition", () => [
      {
        originSelectionRange: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 18 },
        },
        targetUri: helperUri,
        targetRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 29 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 15 },
        },
      },
    ]);
    let helperView: ReturnType<typeof createTestView> | null = null;
    const client = createLeanLspClient({
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          return uri === helperUri ? "def helperValue : Nat := 41\n" : null;
        },
        displayDocument(uri, workspace) {
          const file = workspace.getFile(uri);
          if (!file) {
            return null;
          }
          helperView = createTestView(file.doc.toString(), lean4({ client, uri }));
          return helperView;
        },
      }),
    });
    client.connect(transport);
    const view = createTestView(
      "#check helperValue\n",
      lean4({ client, uri: URI }),
    );

    await client.initializing;
    view.dispatch({ selection: { anchor: 9 } });
    expect(leanJumpToDefinition(view)).toBe(true);
    await waitFor(() => helperView !== null);
    expect(helperView!.state.selection.main.head).toBe(4);

    helperView!.destroy();
    view.destroy();
    client.disconnect();
  });

  it("renames symbols in files loaded from the host workspace", async () => {
    const helperUri = "file:///Helper.lean";
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({
      capabilities: {
        renameProvider: true,
        textDocumentSync: 2,
      },
    }));
    transport.onRequest("textDocument/rename", () => ({
      changes: {
        [URI]: [
          {
            newText: "renamedValue",
            range: {
              start: { line: 0, character: 7 },
              end: { line: 0, character: 18 },
            },
          },
        ],
        [helperUri]: [
          {
            newText: "renamedValue",
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 15 },
            },
          },
        ],
      },
    }));
    const client = createLeanLspClient({
      workspace: createLeanWorkspace({
        loadDocument(uri) {
          return uri === helperUri ? "def helperValue : Nat := 41\n" : null;
        },
      }),
    });
    client.connect(transport);
    const view = createTestView(
      "#check helperValue\n",
      lean4({ client, uri: URI }),
    );

    await client.initializing;
    view.dispatch({ selection: { anchor: 9 } });
    expect(leanRenameSymbol(view)).toBe(true);
    await waitFor(() => !!view.dom.querySelector(".cm-lean-rename-panel"));
    const form = view.dom.querySelector<HTMLFormElement>(".cm-lean-rename-panel form")!;
    form.querySelector("input")!.value = "renamedValue";
    form.requestSubmit();

    await waitFor(() => view.state.doc.toString().includes("renamedValue"));
    expect(
      (client.workspace as LeanWorkspace).getFile(helperUri)?.doc.toString(),
    ).toContain("def renamedValue");

    view.destroy();
    client.disconnect();
  });

  it("reports unknown notifications through the configured fallback", async () => {
    const transport = new MockTransport();
    const unhandled: string[] = [];
    transport.onRequest("initialize", () => ({
      capabilities: {
        textDocumentSync: 2,
      },
    }));
    const client = createLeanLspClient({
      unhandledNotification(_client, method) {
        unhandled.push(method);
      },
    });
    client.connect(transport);
    await client.initializing;

    transport.emitNotification("$/unknownLeanNotification", { ok: true });

    await waitFor(() => unhandled.length === 1);
    expect(unhandled).toEqual(["$/unknownLeanNotification"]);

    client.disconnect();
  });

  it("syncs multiple open Lean documents deterministically", async () => {
    const transport = new MockTransport();
    const client = createInitializedClient(transport);
    const first = createTestView("def first := 1", lean4({ client, uri: URI }));
    const secondUri = "file:///Second.lean";
    const second = createTestView("def second := 2", lean4({ client, uri: secondUri }));

    await client.initializing;
    await waitFor(() => transport.notifications("textDocument/didOpen").length === 2);

    first.dispatch({ changes: { from: first.state.doc.length, insert: "\n#check first" } });
    second.dispatch({ changes: { from: second.state.doc.length, insert: "\n#check second" } });
    client.sync();

    await waitFor(() => transport.notifications("textDocument/didChange").length === 2);
    expect(
      transport.notifications("textDocument/didChange").map((message) => {
        const params = message.params as { textDocument: { uri: string } };
        return params.textDocument.uri;
      }),
    ).toEqual([URI, secondUri]);

    first.destroy();
    second.destroy();
    client.disconnect();
  });
});
