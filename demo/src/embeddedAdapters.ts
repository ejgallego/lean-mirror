import type { AnyEmbeddedBlockEditorAdapter } from "./embeddedBlocks.js";
import { embeddedRustAdapter } from "./embeddedRust.js";

export const demoEmbeddedAdapters: readonly AnyEmbeddedBlockEditorAdapter[] = [
  embeddedRustAdapter,
];
