import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  leanFileProgress,
} from "codemirror-lean4-lsp";

assert.equal(typeof createLeanEditorSession, "function");
assert.equal(typeof createLeanWorkspace, "function");
assert.equal(typeof leanFileProgress, "function");

const packageJsonPath = fileURLToPath(
  import.meta.resolve("codemirror-lean4-lsp/package.json"),
);
const packageRoot = dirname(packageJsonPath);
const css = await readFile(join(packageRoot, "dist", "infoview.css"), "utf8");
assert.match(css, /@font-face/u);
assert((await stat(join(packageRoot, "dist", "codicon.ttf"))).size > 0);

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Document",
  "MutationObserver",
  "DOMParser",
  "customElements",
  "CSSStyleSheet",
  "ShadowRoot",
]) {
  if (name in dom.window) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    });
  }
}
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: dom.window.getComputedStyle.bind(dom.window),
});

const infoview = await import("codemirror-lean4-lsp/infoview");
assert.equal(typeof infoview.createLeanInfoviewHost, "function");
assert.equal(typeof infoview.leanInfoviewClientNotifications, "function");

dom.window.close();
console.log("[packed-consumer] Public package entries imported from installed tarball");
