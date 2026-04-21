import type { Extension } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { leanUtilities } from "../../src/index.js";
import {
  type EmbeddedBlockEditorAdapter,
  embeddedBlockWidgets,
  parseCommentFencedBlocks,
  serializeCommentFencedBlock,
  type EmbeddedBlock,
} from "./embeddedBlocks.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

export interface EmbeddedRustConfig {
  onOpen(block: EmbeddedRustBlock): void;
}

export function parseEmbeddedRustBlocks(source: string): EmbeddedRustBlock[] {
  return parseCommentFencedBlocks(source, {
    defaultTitle(block) {
      return block.label ?? `Rust Block ${block.ordinal}`;
    },
    kind: "rust",
  });
}

export function serializeEmbeddedRustBlock(block: EmbeddedRustBlock, code: string): string {
  return serializeCommentFencedBlock(block, "rust", code);
}

function preview(code: string): string {
  const lines = code.trim().split("\n").slice(0, 3);
  return lines.join("\n");
}

export function embeddedRustWidgets(config: EmbeddedRustConfig): Extension {
  return embeddedBlockWidgets(parseEmbeddedRustBlocks, {
    buttonLabel: "Open Rust editor",
    description() {
      return "Demo widget replacing a marked Lean comment block.";
    },
    kindLabel() {
      return "Embedded Rust";
    },
    onOpen(block) {
      config.onOpen(block);
    },
    preview,
  });
}

export const embeddedRustAdapter: EmbeddedBlockEditorAdapter<EmbeddedRustBlock> = {
  editorExtensions() {
    return [rust(), ...leanUtilities({ lineWrapping: true })];
  },
  parse: parseEmbeddedRustBlocks,
  serialize: serializeEmbeddedRustBlock,
  widgetExtension(onOpen) {
    return embeddedRustWidgets({ onOpen });
  },
};
