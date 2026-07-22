import { HighlightStyle } from "@codemirror/language";
import { Text } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLeanEditorSession,
  createLeanLspClient,
  decodeLeanSemanticTokens,
  lean4,
  leanSemanticTokensFullMethod,
  leanSemanticTokensRefreshMethod,
} from "../src/index.js";
import { createTestView, delay, waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const URI = "file:///Semantic.lean";
const LEGEND = {
  tokenModifiers: ["declaration", "readonly"],
  tokenTypes: ["keyword", "variable", "function"],
};

afterEach(() => {
  document.body.innerHTML = "";
});

function semanticTransport(
  handler: () => unknown | Promise<unknown>,
): MockTransport {
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({
    capabilities: {
      semanticTokensProvider: {
        full: true,
        legend: LEGEND,
      },
      textDocumentSync: 2,
    },
  }));
  transport.onRequest(leanSemanticTokensFullMethod, handler);
  return transport;
}

describe("decodeLeanSemanticTokens", () => {
  it("decodes relative UTF-16 positions, types, and modifiers", () => {
    const doc = Text.of(["ab😀", "xyz"]);
    const tokens = decodeLeanSemanticTokens(
      doc,
      [
        0, 2, 2, 1, 1,
        1, 1, 1, 0, 2,
      ],
      LEGEND,
    );

    expect(tokens).toEqual([
      expect.objectContaining({
        character: 2,
        from: 2,
        line: 0,
        modifiers: ["declaration"],
        to: 4,
        tokenType: "variable",
      }),
      expect.objectContaining({
        character: 1,
        from: 6,
        line: 1,
        modifiers: ["readonly"],
        to: 7,
        tokenType: "keyword",
      }),
    ]);
  });

  it("rejects malformed and out-of-range server data", () => {
    const doc = Text.of(["abc"]);

    expect(() => decodeLeanSemanticTokens(doc, [0, 0], LEGEND)).toThrow(/five integers/);
    expect(() => decodeLeanSemanticTokens(doc, [0, 2, 2, 0, 0], LEGEND)).toThrow(
      /exceeds its line/,
    );
    expect(() => decodeLeanSemanticTokens(doc, [1, 0, 1, 0, 0], LEGEND)).toThrow(
      /exceeds the document/,
    );
  });
});

describe("leanSemanticTokens", () => {
  it("advertises support, renders server tokens, and handles Lean refresh requests", async () => {
    const transport = semanticTransport(() => ({
      data: [
        0, 0, 3, 0, 0,
        0, 4, 5, 1, 1,
        0, 9, 8, 2, 0,
      ],
    }));
    const client = createLeanLspClient({
      features: {
        semanticTokens: {
          className: (token) => `host-token-${token.tokenType}`,
          debounceMs: 0,
        },
      },
    });
    client.connect(transport);
    const hostHighlightStyle = HighlightStyle.define([
      { tag: tags.variableName, class: "host-highlight-variable" },
    ]);
    const view = createTestView(
      "def value := Nat.succ\n",
      lean4({ client, highlightStyle: hostHighlightStyle, uri: URI }),
    );

    await client.initializing;
    await waitFor(() => view.dom.querySelectorAll("[data-lean-semantic-token]").length === 3);

    const initialize = transport.requests("initialize")[0]?.params as {
      capabilities: {
        textDocument: { semanticTokens: { formats: string[] } };
        workspace: { semanticTokens: { refreshSupport: boolean } };
      };
    };
    expect(initialize.capabilities.textDocument.semanticTokens.formats).toContain("relative");
    expect(initialize.capabilities.workspace.semanticTokens.refreshSupport).toBe(true);

    const variable = view.dom.querySelector('[data-lean-semantic-token="variable"]');
    expect(variable?.textContent).toBe("value");
    expect(variable?.classList.contains("cm-lean-semantic-token")).toBe(true);
    expect(variable?.classList.contains("cm-lean-semantic-declaration")).toBe(true);
    expect(variable?.classList.contains("host-token-variable")).toBe(true);
    expect(variable?.classList.contains("host-highlight-variable")).toBe(true);

    const previousRequests = transport.requests(leanSemanticTokensFullMethod).length;
    transport.emitRequest(leanSemanticTokensRefreshMethod, undefined, 99);
    await waitFor(
      () => transport.requests(leanSemanticTokensFullMethod).length > previousRequests,
    );
    await waitFor(() => transport.sent.some(
      (message) => message.id === 99 && message.result === null,
    ));

    view.destroy();
    client.disconnect();
  });

  it("cancels superseded requests and rejects stale token results", async () => {
    const responses: Array<(response: { data: number[] }) => void> = [];
    const transport = semanticTransport(() => new Promise<{ data: number[] }>((resolve) => {
      responses.push(resolve);
    }));
    const client = createLeanLspClient({
      features: { semanticTokens: { debounceMs: 0 } },
      timeout: 5_000,
    });
    client.connect(transport);
    const view = createTestView("def value := 1\n", lean4({ client, uri: URI }));

    await client.initializing;
    await waitFor(() => responses.length === 1);
    view.dispatch({ changes: { from: 4, to: 9, insert: "other" } });
    await waitFor(() => responses.length === 2);
    await waitFor(() => transport.notifications("$/cancelRequest").length === 1);
    const didChangeIndex = transport.sent.findIndex(
      (message) => message.method === "textDocument/didChange",
    );
    const replacementRequest = transport.requests(leanSemanticTokensFullMethod)[1]!;
    expect(didChangeIndex).toBeGreaterThan(-1);
    expect(transport.sent.indexOf(replacementRequest)).toBeGreaterThan(didChangeIndex);

    responses[0]!({ data: [0, 0, 3, 0, 0] });
    await delay(50);
    expect(view.dom.querySelector("[data-lean-semantic-token]")).toBeNull();

    responses[1]!({ data: [0, 4, 5, 1, 0] });
    await waitFor(() =>
      view.dom.querySelector('[data-lean-semantic-token="variable"]')?.textContent === "other",
    );

    view.destroy();
    client.disconnect();
  });

  it("rebuilds semantic decorations for a fresh session client generation", async () => {
    const firstTransport = semanticTransport(() => ({ data: [0, 4, 5, 1, 0] }));
    const secondTransport = semanticTransport(() => ({ data: [0, 4, 5, 2, 0] }));
    const session = createLeanEditorSession({
      client: { features: { semanticTokens: { debounceMs: 0 } } },
    });
    const first = session.connect(firstTransport);
    const view = createTestView(
      "def value := 1\n",
      lean4({ session, uri: URI }),
    );

    await first.initialized;
    await waitFor(() =>
      view.dom.querySelector('[data-lean-semantic-token="variable"]')?.textContent === "value",
    );

    const editorDom = view.dom;
    const second = session.reconnect(secondTransport);
    await second.initialized;
    await waitFor(() =>
      view.dom.querySelector('[data-lean-semantic-token="function"]')?.textContent === "value",
    );

    expect(view.dom).toBe(editorDom);
    expect(view.dom.querySelector('[data-lean-semantic-token="variable"]')).toBeNull();

    view.destroy();
    session.dispose();
  });
});
