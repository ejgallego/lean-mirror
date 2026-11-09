import type { DemoSessionApi } from "./demoSession.js";
import type { AnyEmbeddedBlockEditorAdapter } from "./embeddedBlocks.js";
import { createEmbeddedLeanAdapter } from "./embeddedLean.js";
import { createEmbeddedRustAdapter } from "./embeddedRust.js";

export function createDemoEmbeddedAdapters(
  sessionApi: DemoSessionApi,
  rustInitiallyEditing = false,
): readonly AnyEmbeddedBlockEditorAdapter[] {
  return [createEmbeddedRustAdapter(sessionApi, rustInitiallyEditing), createEmbeddedLeanAdapter()];
}
