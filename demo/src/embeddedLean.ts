import type { Extension } from "@codemirror/state";

import { lean4, leanFallbackHighlightStyle } from "../../src/index.js";
import {
  createLineCommentAdapter,
  type EmbeddedBlock,
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

function leanRole(block: EmbeddedBlock): EmbeddedLeanBlock["role"] {
  const info = "info" in block && typeof block.info === "string" ? block.info.trim().toLowerCase() : "";
  const label = block.label?.trim().toLowerCase();
  return info === "editor-prelude" ||
    info === "prelude" ||
    label === "editor-prelude" ||
    label === "prelude" ||
    label === "imports"
    ? "prelude"
    : "snippet";
}

function lineNumberAt(source: string, offset: number): number {
  const end = Math.max(0, Math.min(source.length, offset));
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    const char = source[index];
    if (char === "\r") {
      line += 1;
      if (source[index + 1] === "\n") {
        index += 1;
      }
    } else if (char === "\n") {
      line += 1;
    }
  }
  return line;
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
  if (options.preamble && options.preamble.length > 0) {
    lines.push(...options.preamble);
    lines.push("");
  }

  for (const block of [...prelude, ...snippets]) {
    const line = lineNumberAt(source, block.from);
    const title = block.label ?? `block ${block.ordinal}`;
    lines.push(`/- ${title} from ${options.sourceName ?? "Rust source"}:${line} -/`);
    const codeLines = block.code.split("\n");
    for (const [index, codeLine] of codeLines.entries()) {
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

  if (options.postamble && options.postamble.length > 0) {
    lines.push(...options.postamble);
    lines.push("");
  }

  return {
    blocks,
    doc: lines.join("\n").trimEnd() + "\n",
    mappings,
  };
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
  const blocks = parseEmbeddedLeanBlocks(source).sort((left, right) => left.from - right.from);
  if (blocks.length === 0) {
    return source;
  }
  let cursor = 0;
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(source.slice(cursor, block.from));
    cursor = block.to;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
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
