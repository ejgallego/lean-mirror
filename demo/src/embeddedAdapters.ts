import type { DemoSessionApi } from "./demoSession.js";
import type { AnyEmbeddedBlockEditorAdapter } from "./embeddedBlocks.js";
import { createEmbeddedLeanAdapter } from "./embeddedLean.js";
import { createEmbeddedRustAdapter, type RustPresentation } from "./embeddedRust.js";

export function createDemoEmbeddedAdapters(
  sessionApi: DemoSessionApi,
  rustPresentation: RustPresentation = "source",
): readonly AnyEmbeddedBlockEditorAdapter[] {
  return [createEmbeddedRustAdapter(sessionApi, rustPresentation), createEmbeddedLeanAdapter()];
}
