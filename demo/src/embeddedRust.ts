import type { Extension } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { leanUtilities } from "../../src/index.js";
import {
  createCommentFencedAdapter,
  type EmbeddedBlock,
} from "./embeddedBlocks.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

function preview(code: string): string {
  const lines = code.trim().split("\n").slice(0, 3);
  return lines.join("\n");
}

const adapter = createCommentFencedAdapter<EmbeddedRustBlock>({
  defaultTitle(block) {
    return block.label ?? `Rust Block ${block.ordinal}`;
  },
  description() {
    return "Demo widget replacing a marked Lean comment block.";
  },
  editorExtensions(): Extension[] {
    return [rust(), ...leanUtilities({ lineWrapping: true })];
  },
  kind: "rust",
  kindLabel() {
    return "Embedded Rust";
  },
  preview,
});

export const embeddedRustAdapter = adapter;
export const parseEmbeddedRustBlocks = adapter.parseBlocks;
export const serializeEmbeddedRustBlock = adapter.serializeBlock;
