import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import type * as lsp from "vscode-languageserver-protocol";
import { sanitizeHtml } from "./sanitizeHtml.js";

export function normalizeRustHover(
  contents: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
): lsp.MarkupContent | null {
  const strip = (text: string) => text.replace(/^(?:widget|embedded_[a-z0-9_]+)\r?\n\r?\n/, "");
  if (Array.isArray(contents)) {
    const parts = contents.map(normalizeRustHover).filter(item => item !== null).map(item => item.value);
    return parts.length ? { kind: "markdown", value: parts.join("\n\n") } : null;
  }
  if (typeof contents === "string") return { kind: "markdown", value: strip(contents) };
  if ("language" in contents) return {
    kind: "markdown", value: `\`\`\`${contents.language}\n${strip(contents.value)}\n\`\`\``,
  };
  return { kind: contents.kind, value: strip(contents.value) };
}

export function rustHoverDom(view: EditorView, contents: lsp.MarkupContent): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
  const plugin = LSPPlugin.get(view);
  if (plugin) dom.innerHTML = sanitizeHtml(plugin.docToHTML(contents));
  else dom.textContent = contents.value;
  return dom;
}
