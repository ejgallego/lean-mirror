import type { Extension } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { leanUtilities } from "../../src/index.js";
import {
  createCommentFencedAdapter,
  type EmbeddedBlock,
} from "./embeddedBlocks.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

const adapter = createCommentFencedAdapter<EmbeddedRustBlock>({
  defaultTitle(block) {
    return block.label ?? `Rust Block ${block.ordinal}`;
  },
  editorExtensions(): Extension[] {
    return [rust(), ...leanUtilities({ lineWrapping: true })];
  },
  kind: "rust",
});

export const embeddedRustAdapter = adapter;
export const parseEmbeddedRustBlocks = adapter.parseBlocks;
export const serializeEmbeddedRustBlock = adapter.serializeBlock;
