import assert from "node:assert/strict";

import {
  createLeanEditorSession,
  createLeanWorkspace,
  leanFileProgress,
} from "codemirror-lean4-lsp";

assert.equal(typeof createLeanEditorSession, "function");
assert.equal(typeof createLeanWorkspace, "function");
assert.equal(typeof leanFileProgress, "function");

const core = await import("codemirror-lean4-lsp");
assert.equal("createLeanInfoviewHost" in core, false);

console.log("[packed-consumer] Core entry imported without optional infoview peers");
