import { parseLineCommentFencedBlocks } from "./embeddedLineComments.mjs";

export function embeddedLeanRole(info) {
  const words = (info ?? "").trim().toLowerCase().split(/[\s,]+/u);
  return words.some((word) => ["prelude", "editor-prelude", "imports"].includes(word))
    ? "prelude" : "snippet";
}

/** One source of generated text and line mappings for browser and backend. */
export function renderEmbeddedLeanDocument(source, options = {}) {
  const blocks = parseLineCommentFencedBlocks(source, {
    kind: "lean", linePrefixes: ["//!", "///", "//"],
  }).map((block) => ({ ...block, role: embeddedLeanRole(block.info ?? block.label) }));
  const ordered = [...blocks.filter((block) => block.role === "prelude"),
    ...blocks.filter((block) => block.role !== "prelude")];
  const lines = [];
  const mappings = [];
  for (const moduleName of options.defaultImports ?? []) lines.push(`import ${moduleName}`);
  if (options.defaultImports?.length) lines.push("");
  if (options.preamble?.length) lines.push(...options.preamble, "");
  for (const block of ordered) {
    const title = (block.label ?? `block ${block.ordinal}`).replaceAll(",", " ").trim().replace(/\s+/gu, " ");
    lines.push(`/- ${title} from ${options.sourceName ?? "Rust source"}:${block.sourceLine} -/`);
    let blockLineStart = 0;
    for (const codeLine of block.code.split("\n")) {
      mappings.push({ blockKey: block.key, blockLineStart, generatedLine: lines.length });
      lines.push(codeLine);
      blockLineStart += codeLine.length + 1;
    }
    lines.push("");
  }
  if (options.postamble?.length) lines.push(...options.postamble, "");
  return { blocks, doc: lines.join("\n").trimEnd() + "\n", mappings };
}
