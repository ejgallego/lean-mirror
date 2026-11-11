import { describe, expect, it } from "vitest";
import type { RustSession } from "../demo/src/demoSession.js";
import { parseEmbeddedRustBlocks } from "../demo/src/embeddedRust.js";
import { RustSourceSession, filterLeanHovers, rustPositionAt, rustPositionInSource } from "../demo/src/rustSourceHover.js";
import { createLeanLspClient } from "../src/index.js";
import { waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

const info: RustSession = { key: "rust:probe:session", documentUri: "file:///probe/src/lib.rs",
  rootUri: "file:///probe", websocketUrl: "ws://probe/rust-lsp" };

class Socket extends EventTarget {
  readyState = 1;
  constructor(readonly transport: MockTransport) {
    super();
    transport.subscribe(data => this.dispatchEvent(new MessageEvent("message", { data })));
  }
  send(data: string): void { this.transport.send(data); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function harness(code = "pub fn probe() -> i32 { 42 }") {
  const transport = new MockTransport();
  transport.onRequest("initialize", () => ({ capabilities: { hoverProvider: true, textDocumentSync: 1 } }));
  transport.onRequest("rosetta/ready", () => true);
  transport.onRequest("textDocument/hover", () => ({ contents: "probe" }));
  const socket = new Socket(transport);
  const released: string[] = [];
  const session = new RustSourceSession({
    releaseRustSession: async key => { released.push(key); },
    createRustSession: async () => info,
    connectWebSocket: async () => socket as unknown as WebSocket,
  }, "rust:probe", code);
  return { session, socket, transport, released };
}

describe("raw Verso Rust hover", () => {
  it("routes Rust body hovers away from Lean while keeping Lean hovers elsewhere", async () => {
    const transport = new MockTransport();
    transport.onRequest("initialize", () => ({ capabilities: { hoverProvider: true } }));
    transport.onRequest("textDocument/hover", () => ({ contents: "Lean" }));
    const client = createLeanLspClient({ extensions: [filterLeanHovers(params => params.position.line === 3)] });
    client.connect(transport);
    try {
      await client.initializing;
      await expect(client.request("textDocument/hover", {
        textDocument: { uri: "file:///Main.lean" }, position: { line: 3, character: 1 },
      })).resolves.toBeNull();
      expect(transport.requests("textDocument/hover")).toHaveLength(0);
      await expect(client.request("textDocument/hover", {
        textDocument: { uri: "file:///Main.lean" }, position: { line: 0, character: 1 },
      })).resolves.toEqual({ contents: "Lean" });
      expect(transport.requests("textDocument/hover")).toHaveLength(1);
    } finally { client.disconnect(); }
  });

  it("maps CRLF and UTF-16 body positions without claiming fences or prose", () => {
    const source = '/-!\r\nBefore 𝒜.\r\n```rust (name := first)\r\n// 𝒜\r\nfn first() { /* 𝒜 */ first(); }\r\n```\r\nBetween.\r\n```rust (name := second)\r\nfn second() {}\r\n```\r\nAfter.\r\n-/\r\n';
    const [first, second] = parseEmbeddedRustBlocks(source);
    const offset = source.indexOf("first();");
    const position = rustPositionAt(first!, offset)!;
    expect(position).toEqual({ line: 1, character: 'fn first() { /* 𝒜 */ '.length });
    expect(rustPositionInSource(first!, position)).toBe(offset);
    expect(rustPositionAt(second!, source.indexOf("fn second"))).toEqual({ line: 0, character: 0 });
    for (const text of ["Before", "```rust", "Between", "After", "-/"]) {
      expect(rustPositionAt(first!, source.indexOf(text))).toBeNull();
    }
    expect(rustPositionInSource(first!, { line: 2, character: 0 })).toBeNull();
    expect(rustPositionInSource(first!, { line: 0, character: 100 })).toBeNull();
  });

  it("opens an overlay without a nested editor and syncs authored edits before hover", async () => {
    const { session, transport, released } = harness();
    try {
      await expect(session.hover({ line: 0, character: 8 })).resolves.toEqual({ contents: "probe" });
      expect(transport.notifications("textDocument/didOpen")[0]?.params).toMatchObject({
        textDocument: { uri: info.documentUri, languageId: "rust", text: "pub fn probe() -> i32 { 42 }" },
      });
      session.setCode("pub fn probe() -> i64 { 42 }");
      await session.hover({ line: 0, character: 8 });
      const change = transport.notifications("textDocument/didChange")[0];
      expect(change?.params).toMatchObject({ contentChanges: [{ text: "pub fn probe() -> i64 { 42 }" }] });
      expect(transport.sent.indexOf(change!)).toBeLessThan(transport.sent.indexOf(transport.requests("textDocument/hover")[1]!));
    } finally { session.destroy(); }
    expect(transport.notifications("textDocument/didClose")).toHaveLength(1);
    expect(released).toEqual([info.key]);
  });

  it("discards an in-flight result even if edits restore the original text", async () => {
    const { session, transport } = harness();
    let respond!: (value: unknown) => void;
    transport.onRequest("textDocument/hover", () => new Promise(resolve => { respond = resolve; }));
    try {
      const hover = session.hover({ line: 0, character: 8 });
      await waitFor(() => transport.requests("textDocument/hover").length === 1);
      session.setCode("pub fn probe() -> i64 { 42 }");
      session.setCode("pub fn probe() -> i32 { 42 }");
      respond({ contents: "stale" });
      await expect(hover).resolves.toBeNull();
    } finally { session.destroy(); }
  });

  it("cancels pending hover work when its socket closes", async () => {
    const { session, socket, transport } = harness();
    transport.onRequest("textDocument/hover", () => new Promise(() => {}));
    try {
      const hover = expect(session.hover({ line: 0, character: 8 })).rejects.toMatchObject({ name: "AbortError" });
      await waitFor(() => transport.requests("textDocument/hover").length === 1);
      socket.close();
      await hover;
      expect(session.closed).toBe(true);
    } finally { session.destroy(); }
  });

  it("does not connect a session whose host closed during creation", async () => {
    let finish!: (session: RustSession) => void;
    let connections = 0;
    const released: string[] = [];
    const session = new RustSourceSession({
      releaseRustSession: async key => { released.push(key); },
      createRustSession: () => new Promise(resolve => { finish = resolve; }),
      connectWebSocket: async () => { connections++; throw new Error("unexpected connection"); },
    }, "rust:pending", "fn pending() {}");
    const hover = session.hover({ line: 0, character: 4 });
    session.destroy();
    finish(info);
    await expect(hover).resolves.toBeNull();
    expect(connections).toBe(0);
    expect(released).toEqual([info.key]);
  });
});
