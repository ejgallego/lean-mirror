import type { EmbeddedLeanRenderOptions } from "../shared/embeddedLeanDocument.mjs";
export function buildEmbeddedLeanDocumentFromSource(source: string, options?: EmbeddedLeanRenderOptions): string;
export function ensureEmbeddedLeanArtifacts(path: string, context: EmbeddedLeanRenderOptions & {
  sourcePath?: string;
  externalMode?: boolean;
}): Promise<void>;
