import type { ParsedLineCommentFencedBlock } from "./embeddedLineComments.mjs";
export interface EmbeddedLeanRenderOptions {
  defaultImports?: readonly string[];
  preamble?: readonly string[];
  postamble?: readonly string[];
  sourceName?: string;
}
export function embeddedLeanRole(info: string | null | undefined): "prelude" | "snippet";
export function renderEmbeddedLeanDocument(source: string, options?: EmbeddedLeanRenderOptions): {
  blocks: (ParsedLineCommentFencedBlock & { role: "prelude" | "snippet" })[];
  doc: string;
  mappings: { blockKey: string; blockLineStart: number; generatedLine: number }[];
};
