import type { Extension } from "@codemirror/state";
import { embeddedLeanRole, renderEmbeddedLeanDocument } from "../shared/embeddedLeanDocument.mjs";

import { lean4, leanFallbackHighlightStyle } from "codemirror-lean4-lsp";
import { lineCommentFencedHostFingerprint } from "../shared/embeddedLineComments.mjs";
import {
  createLineCommentAdapter,
  type EmbeddedBlockDiagnostic,
  type LineCommentEmbeddedBlock,
} from "./embeddedBlocks.js";

export interface EmbeddedLeanBlock extends LineCommentEmbeddedBlock {
  role: "prelude" | "snippet";
}

export interface EmbeddedLeanDocument {
  blocks: EmbeddedLeanBlock[];
  doc: string;
  mappings: EmbeddedLeanDocumentMapping[];
}

export interface EmbeddedLeanDocumentOptions {
  defaultImports?: readonly string[];
  preamble?: readonly string[];
  postamble?: readonly string[];
  sourceName?: string;
}

export interface EmbeddedLeanDocumentMapping {
  blockKey: string;
  blockLineStart: number;
  generatedLine: number;
}

export interface EmbeddedLeanDiagnosticInput {
  message: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  severity?: EmbeddedBlockDiagnostic["severity"];
}

function withRole(block: LineCommentEmbeddedBlock): EmbeddedLeanBlock {
  return { ...block, role: embeddedLeanRole(block.info ?? block.label) };
}

export function buildEmbeddedLeanDocument(
  source: string,
  options: EmbeddedLeanDocumentOptions = {},
): EmbeddedLeanDocument {
  const rendered = renderEmbeddedLeanDocument(source, options);
  return { ...rendered, blocks: rendered.blocks.map((block) => ({
    ...block, title: block.label ?? `Lean Block ${block.ordinal}`,
  })) };
}

export function mapEmbeddedLeanDiagnostics(
  document: EmbeddedLeanDocument,
  diagnostics: readonly EmbeddedLeanDiagnosticInput[],
): Map<string, EmbeddedBlockDiagnostic[]> {
  const byBlock = new Map<string, EmbeddedBlockDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const start = document.mappings.find(
      (mapping) => mapping.generatedLine === diagnostic.range.start.line,
    );
    if (!start) {
      continue;
    }
    const end =
      document.mappings.find(
        (mapping) => mapping.generatedLine === diagnostic.range.end.line && mapping.blockKey === start.blockKey,
      ) ?? start;
    const mapped = byBlock.get(start.blockKey) ?? [];
    mapped.push({
      from: start.blockLineStart + diagnostic.range.start.character,
      message: diagnostic.message,
      ...(diagnostic.severity === undefined ? {} : { severity: diagnostic.severity }),
      to: Math.max(
        start.blockLineStart + diagnostic.range.start.character,
        end.blockLineStart + diagnostic.range.end.character,
      ),
    });
    byBlock.set(start.blockKey, mapped);
  }
  return byBlock;
}

export function embeddedLeanHostFingerprint(source: string): string {
  return lineCommentFencedHostFingerprint(source, {
    kind: "lean",
    linePrefixes: ["//!", "///", "//"],
  });
}

const baseLeanAdapter = createLineCommentAdapter<EmbeddedLeanBlock>({
  defaultTitle(block) {
    return block.label ?? `Lean Block ${block.ordinal}`;
  },
  displayName: "Lean",
  editorExtensions(): Extension[] {
    return lean4({
      highlightStyle: leanFallbackHighlightStyle,
      utilities: {
        activeLine: false,
        defaultKeymap: true,
        drawSelection: true,
        foldGutter: false,
        foldKeymap: false,
        history: true,
        historyKeymap: true,
        indentWithTab: true,
        lineNumbers: false,
        lineWrapping: true,
        search: false,
        searchKeymap: false,
      },
    });
  },
  hostLanguageIds: ["rust"],
  kind: "lean",
  linePrefixes: ["//!", "///", "//"],
  preferredLinePrefix: "//!",
  scaffold: {
    baseLabel: "demo-lean",
    code() {
      return "#check helperValue\n#check Nat.succ";
    },
  },
});

export function parseEmbeddedLeanBlocks(source: string): EmbeddedLeanBlock[] {
  return baseLeanAdapter.parseBlocks(source).map(withRole);
}

export const serializeEmbeddedLeanBlock = baseLeanAdapter.serializeBlock;

export function createEmbeddedLeanAdapter() {
  return {
    ...baseLeanAdapter,
    parse(source: string) {
      return parseEmbeddedLeanBlocks(source);
    },
    parseBlocks(source: string) {
      return parseEmbeddedLeanBlocks(source);
    },
  };
}
