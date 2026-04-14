import { CompletionContext } from "@codemirror/autocomplete";
import { diagnosticCount } from "@codemirror/lint";
import { languageServerExtensions, serverCompletionSource } from "@codemirror/lsp-client";
import { afterEach, describe, expect, it } from "vitest";

import { createLeanLspClient, lean4, leanLspExtensions } from "../src/index.js";
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
      hoverProvider: true,
      textDocumentSync: 2,
    },
  }));
  const client = createLeanLspClient();
  client.connect(transport);
  return client;
}

describe("leanLspExtensions", () => {
  it("uses CodeMirror's official bundled extensions by default", () => {
    expect(leanLspExtensions()).toHaveLength(languageServerExtensions().length);
  });
});

describe("lean4", () => {
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
});
