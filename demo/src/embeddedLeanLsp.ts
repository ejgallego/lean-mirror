import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";
import type { EditorDiagnostic } from "@leanprover/editor-platform";
import { Marked } from "marked";

import type { EmbeddedBlockDiagnostic } from "./embeddedBlocks.js";
import type { ActiveEmbeddedEditor } from "./embeddedEditorShell.js";
import type { EmbeddedLeanDocument } from "./embeddedLean.js";
import { sanitizeHtml } from "./sanitizeHtml.js";

const leanHoverMarkdown = new Marked();

function escapeHtml(text: string): string {
  return text.replace(/[&<>\n]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "<br>";
    }
  });
}

export function diagnosticSeverity(
  value?: lsp.DiagnosticSeverity,
): NonNullable<EmbeddedBlockDiagnostic["severity"]> {
  return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : "hint";
}

export function editorDiagnosticsFromLsp(
  uri: string,
  source: string,
  diagnostics: readonly lsp.Diagnostic[],
): EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    uri,
    source,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic.severity),
    ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
  }));
}

export interface EmbeddedLeanLspFeatures {
  hoverTooltips(blockKey: string): Extension;
  location(editor: ActiveEmbeddedEditor): lsp.Location | undefined;
  offset(blockKey: string, view: EditorView, position: lsp.Position): number | null;
  position(blockKey: string, view: EditorView, offset: number): lsp.Position | null;
}

export interface EmbeddedLeanLspFeatureOptions {
  client(): LSPClient | null;
  document(): EmbeddedLeanDocument | null;
  documentUri(): string | undefined;
}

export function createEmbeddedLeanLspFeatures(
  options: EmbeddedLeanLspFeatureOptions,
): EmbeddedLeanLspFeatures {
  function position(blockKey: string, view: EditorView, offset: number): lsp.Position | null {
    const document = options.document();
    if (!document) {
      return null;
    }
    const clamped = Math.max(0, Math.min(view.state.doc.length, offset));
    const line = view.state.doc.lineAt(clamped);
    const blockMappings = document.mappings.filter((mapping) => mapping.blockKey === blockKey);
    const mapping = blockMappings.find((candidate) => candidate.blockLineStart === line.from)
      ?? blockMappings[line.number - 1];
    if (!mapping) {
      return null;
    }
    return {
      character: Math.max(0, clamped - line.from),
      line: mapping.generatedLine,
    };
  }

  function offset(blockKey: string, view: EditorView, target: lsp.Position): number | null {
    const document = options.document();
    if (!document) {
      return null;
    }
    const mapping = document.mappings.find(
      (candidate) => candidate.blockKey === blockKey && candidate.generatedLine === target.line,
    );
    if (!mapping) {
      return null;
    }
    return Math.max(
      0,
      Math.min(view.state.doc.length, mapping.blockLineStart + target.character),
    );
  }

  function renderLeanHoverMarkdown(value: string): string {
    const html = leanHoverMarkdown.parse(value, { async: false });
    return typeof html === "string" ? sanitizeHtml(html) : "";
  }

  function leanHoverHtml(
    contents: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
  ): string {
    if (Array.isArray(contents)) {
      return contents.map((item) => leanHoverHtml(item)).filter(Boolean).join("<br>");
    }
    if (typeof contents === "string") {
      return renderLeanHoverMarkdown(contents);
    }
    if ("language" in contents) {
      return renderLeanHoverMarkdown(`\`\`\`${contents.language}\n${contents.value}\n\`\`\``);
    }
    return contents.kind === "markdown" ? renderLeanHoverMarkdown(contents.value) : escapeHtml(contents.value);
  }

  function hoverTooltips(blockKey: string): Extension {
    return hoverTooltip((view, pos): Promise<Tooltip | null> => {
      const client = options.client();
      const documentUri = options.documentUri();
      if (!client || !documentUri || client.serverCapabilities?.hoverProvider === false) {
        return Promise.resolve(null);
      }
      const target = position(blockKey, view, pos);
      if (!target) {
        return Promise.resolve(null);
      }
      client.sync();
      return client
        .request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
          position: target,
          textDocument: { uri: documentUri },
        })
        .then((result) => {
          if (!result) {
            return null;
          }
          const html = leanHoverHtml(result.contents).trim();
          if (!html) {
            return null;
          }
          const start = result.range ? offset(blockKey, view, result.range.start) ?? pos : pos;
          const end = result.range ? offset(blockKey, view, result.range.end) ?? pos : pos;
          return {
            above: true,
            end,
            pos: start,
            create() {
              const dom = document.createElement("div");
              dom.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
              dom.innerHTML = html;
              return { dom };
            },
          };
        })
        .catch(() => null);
    }, { hideOn: (transaction) => transaction.docChanged });
  }

  function location(editor: ActiveEmbeddedEditor): lsp.Location | undefined {
    const documentUri = options.documentUri();
    if (editor.adapter.kind !== "lean" || !documentUri) {
      return undefined;
    }
    const selection = editor.view.state.selection.main;
    const start = position(editor.block.key, editor.view, selection.from);
    const end = position(editor.block.key, editor.view, selection.to);
    return start && end ? { range: { end, start }, uri: documentUri } : undefined;
  }

  return { hoverTooltips, location, offset, position };
}
