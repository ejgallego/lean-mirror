import { ChangeSet, Text } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import { describe, expect, it } from "vitest";

import { createLeanLspClient } from "../src/index.js";
import {
  lspClientInternalsSupported,
  mappingStartDocument,
  recordClosedFileChanges,
  trackLateLoadedFile,
} from "../src/lspClientInternals.js";

const URI = "file:///Late.lean";

// Canary for @codemirror/lsp-client upgrades: these internals back late-loaded
// files and hidden-document edits in reference, rename, and navigation mappings.
describe("@codemirror/lsp-client internals", () => {
  it("still have the shapes lean-mirror relies on", () => {
    expect(lspClientInternalsSupported(createLeanLspClient())).toBe(true);
  });

  it("track a late-loaded file and closed-file changes in active mappings", () => {
    const client = createLeanLspClient();
    const mapping = client.workspaceMapping();
    const doc = Text.of(["def late := 1"]);

    expect(mapping.getMapping(URI)).toBeNull();
    trackLateLoadedFile(client, URI, doc);
    expect(mapping.getMapping(URI)).not.toBeNull();
    expect(mappingStartDocument(mapping, URI)).toBe(doc);

    // Insert a line before the definition; request-time positions shift with it.
    recordClosedFileChanges(client, URI, ChangeSet.of({ from: 0, insert: "-- note\n" }, doc.length));
    expect(mapping.mapPosition(URI, { line: 0, character: 4 })).toBe("-- note\n".length + 4);

    // A file already tracked keeps its original start document.
    trackLateLoadedFile(client, URI, Text.of(["other"]));
    expect(mappingStartDocument(mapping, URI)).toBe(doc);
    mapping.destroy();
  });

  it("degrade to no-ops when the internals are missing", () => {
    const foreign = { workspaceMapping: () => ({ destroy() {} }) } as unknown as LSPClient;
    expect(() => trackLateLoadedFile(foreign, URI, Text.empty)).not.toThrow();
    expect(() => recordClosedFileChanges(foreign, URI, ChangeSet.empty(0))).not.toThrow();
    expect(lspClientInternalsSupported(foreign)).toBe(false);
  });
});
