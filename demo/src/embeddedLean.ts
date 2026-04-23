import type { Extension } from "@codemirror/state";

import { lean4 } from "../../src/index.js";
import {
  createLineCommentAdapter,
  type EmbeddedBlock,
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
  sourceName?: string;
}

export interface EmbeddedLeanDocumentMapping {
  blockKey: string;
  blockLineStart: number;
  generatedLine: number;
}

function leanRole(block: EmbeddedBlock): EmbeddedLeanBlock["role"] {
  const label = block.label?.trim().toLowerCase();
  return label === "prelude" || label === "imports" ? "prelude" : "snippet";
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split("\n").length;
}

function withRole(block: LineCommentEmbeddedBlock): EmbeddedLeanBlock {
  return {
    ...block,
    role: leanRole(block),
  };
}

export function buildEmbeddedLeanDocument(
  source: string,
  options: EmbeddedLeanDocumentOptions = {},
): EmbeddedLeanDocument {
  const blocks = parseEmbeddedLeanBlocks(source);
  const defaultImports = options.defaultImports ?? [];
  const prelude = blocks.filter((block) => block.role === "prelude");
  const snippets = blocks.filter((block) => block.role !== "prelude");
  const lines: string[] = [];
  const mappings: EmbeddedLeanDocumentMapping[] = [];

  for (const moduleName of defaultImports) {
    lines.push(`import ${moduleName}`);
  }
  if (defaultImports.length > 0) {
    lines.push("");
  }

  for (const block of [...prelude, ...snippets]) {
    const line = lineNumberAt(source, block.from);
    const title = block.label ?? `block ${block.ordinal}`;
    lines.push(`/- ${title} from ${options.sourceName ?? "Rust source"}:${line} -/`);
    for (const [index, codeLine] of block.code.split("\n").entries()) {
      mappings.push({
        blockKey: block.key,
        blockLineStart: block.code
          .split("\n")
          .slice(0, index)
          .reduce((offset, current) => offset + current.length + 1, 0),
        generatedLine: lines.length,
      });
      lines.push(codeLine);
    }
    lines.push("");
  }

  return {
    blocks,
    doc: lines.join("\n").trimEnd() + "\n",
    mappings,
  };
}

const baseLeanAdapter = createLineCommentAdapter<EmbeddedLeanBlock>({
  defaultTitle(block) {
    return block.label ?? `Lean Block ${block.ordinal}`;
  },
  displayName: "Lean",
  editorExtensions(): Extension[] {
    return lean4({
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
