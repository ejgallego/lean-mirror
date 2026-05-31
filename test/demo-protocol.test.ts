import { describe, expect, it } from "vitest";

import {
  documentEndpoint,
  parseCreateRustSessionRequest,
  parseDemoPreparationStatus,
  parseDemoSession,
  parseDocumentResponse,
  parseRustMainUpdateRequest,
  parseRustMainUpdateResult,
  parseRustSession,
  parseUpdateRustDocumentRequest,
} from "../demo/shared/demoProtocol.mjs";

describe("demo protocol", () => {
  it("parses session and document responses", () => {
    const session = parseDemoSession({
      rootUri: "file:///workspace",
      documentUri: "file:///workspace/Main.rs",
      documentLanguageIds: {
        "file:///workspace/Main.rs": "rust",
      },
      documents: ["file:///workspace/Main.rs"],
      embeddedLeanDocumentUri: "file:///workspace/RustSnippets.lean",
      initialDoc: "fn main() {}\n",
      preparationStatus: {
        message: "Demo workspace ready.",
        phase: "ready",
        updatedAt: "2026-05-26T00:00:00.000Z",
      },
      rustMainDocumentUri: "file:///workspace/Main.rs",
      rustMainWebsocketUrl: "ws://127.0.0.1:7357/rust-main-lsp",
      websocketUrl: "ws://127.0.0.1:7357/lsp",
    });

    expect(session.documents).toEqual(["file:///workspace/Main.rs"]);
    expect(session.documentLanguageIds).toEqual({
      "file:///workspace/Main.rs": "rust",
    });
    expect(session.preparationStatus?.phase).toBe("ready");
    expect(parseDemoPreparationStatus(session.preparationStatus)).toEqual(session.preparationStatus);
    expect(parseDocumentResponse({ uri: session.documentUri, text: "text" })).toEqual({
      uri: session.documentUri,
      text: "text",
    });
  });

  it("parses Rust request and response payloads", () => {
    expect(parseCreateRustSessionRequest({ key: "block", code: "fn main() {}" })).toEqual({
      key: "block",
      code: "fn main() {}",
    });
    expect(parseRustSession({ documentUri: "file:///tmp/lib.rs", rootUri: "file:///tmp", websocketUrl: "ws://x" }))
      .toEqual({
        documentUri: "file:///tmp/lib.rs",
        rootUri: "file:///tmp",
        websocketUrl: "ws://x",
      });
    expect(parseUpdateRustDocumentRequest({ key: "block", code: "new", version: 2 })).toEqual({
      key: "block",
      code: "new",
      version: 2,
    });
    expect(parseRustMainUpdateRequest({
      code: "fn changed() {}",
      leanDocument: "#check Nat",
      revision: 4,
      uri: "file:///workspace/Main.rs",
    })).toEqual({
      code: "fn changed() {}",
      leanDocument: "#check Nat",
      revision: 4,
      uri: "file:///workspace/Main.rs",
    });
    expect(parseRustMainUpdateResult({ leanDocumentUri: "file:///workspace/RustSnippets.lean", revision: 4 }))
      .toEqual({
        leanDocumentUri: "file:///workspace/RustSnippets.lean",
        revision: 4,
      });
  });

  it("rejects malformed payloads", () => {
    expect(() => parseDemoSession({ rootUri: "file:///workspace" })).toThrow(/documentUri/);
    expect(() => parseUpdateRustDocumentRequest({ key: "block", code: "new", version: Number.NaN }))
      .toThrow(/version/);
    expect(() => parseRustMainUpdateResult({ leanDocumentUri: "file:///workspace/RustSnippets.lean", revision: "4" }))
      .toThrow(/revision/);
  });

  it("builds encoded document URLs", () => {
    expect(documentEndpoint("http://127.0.0.1:7357", "file:///tmp/A B.lean"))
      .toBe("http://127.0.0.1:7357/document?uri=file%3A%2F%2F%2Ftmp%2FA%20B.lean");
  });
});
