import { describe, expect, test } from "vitest";

import {
  createDocumentSnapshot,
  documentTitleFromUri,
  inferLanguageIdFromUri
} from "../src/index.js";

describe("editor platform documents", () => {
  test("derives compact document titles from file and virtual URIs", () => {
    expect(documentTitleFromUri("file:///workspace/Main.lean")).toBe("Main.lean");
    expect(documentTitleFromUri("demo://workspace/RustSnippets.lean?version=2#block")).toBe(
      "RustSnippets.lean"
    );
    expect(documentTitleFromUri("verso-entry://manual-intro")).toBe("manual-intro");
    expect(documentTitleFromUri("untitled:Scratch.lean")).toBe("untitled:Scratch.lean");
    expect(documentTitleFromUri("file:///workspace/My%20File.lean")).toBe("My File.lean");
  });

  test("infers language IDs from common editor file extensions", () => {
    expect(inferLanguageIdFromUri("file:///workspace/Main.lean")).toBe("lean4");
    expect(inferLanguageIdFromUri("demo://workspace/Main.rs")).toBe("rust");
    expect(inferLanguageIdFromUri("file:///workspace/README.md")).toBe("markdown");
    expect(inferLanguageIdFromUri("file:///workspace/Unknown.custom")).toBe("text");
    expect(inferLanguageIdFromUri("file:///workspace/Unknown.custom", { fallback: "lean4" })).toBe(
      "lean4"
    );
    expect(
      inferLanguageIdFromUri("file:///workspace/Example.lean", {
        extensionMap: { ".lean": "lean" }
      })
    ).toBe("lean");
    expect(
      inferLanguageIdFromUri("file:///workspace/Main.rs", {
        extensionMap: { ".lean": "lean" }
      })
    ).toBe("rust");
  });

  test("creates document snapshots while preserving selected previous fields", () => {
    const previous = createDocumentSnapshot({
      uri: "file:///workspace/Main.lean",
      languageId: "lean4",
      version: 7,
      openState: "open",
      syncState: "failed",
      title: "Main.lean",
      lastError: "Lean exited"
    });

    expect(
      createDocumentSnapshot({
        uri: "file:///workspace/Main.lean",
        previous,
        syncState: "dirty"
      })
    ).toEqual({
      uri: "file:///workspace/Main.lean",
      languageId: "lean4",
      version: 7,
      openState: "open",
      syncState: "dirty",
      title: "Main.lean"
    });
  });

  test("supports explicit defaults for new virtual documents", () => {
    expect(
      createDocumentSnapshot({
        uri: "verso-entry://manual-intro",
        languageFallback: "lean4"
      })
    ).toEqual({
      uri: "verso-entry://manual-intro",
      languageId: "lean4",
      version: 0,
      openState: "open",
      syncState: "clean",
      title: "manual-intro"
    });
  });
});
