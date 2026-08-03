import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseLineCommentFencedBlocks } from "../shared/embeddedLineComments.mjs";

function defaultEmbeddedLeanDocument({ defaultImports = [], externalMode = false, postamble = [], preamble = [] } = {}) {
  if (externalMode) {
    const imports = defaultImports.map((moduleName) => `import ${moduleName}`);
    return [
      ...imports,
      imports.length > 0 ? "" : null,
      ...preamble,
      preamble.length > 0 ? "" : null,
      ...postamble,
      "",
    ].filter((line) => line !== null).join("\n");
  }
  return [
    "/- prelude from Main.rs -/",
    "import Helper",
    "",
    "/- demo-check from Main.rs -/",
    "#check helperValue",
    "#check Nat.succ",
    "",
  ].join("\n");
}

function embeddedLeanRole(info) {
  const normalized = info.toLowerCase();
  return normalized === "editor-prelude" ||
    normalized === "prelude" ||
    normalized.startsWith("editor-prelude,") ||
    normalized.startsWith("editor-prelude ") ||
    normalized.startsWith("prelude,") ||
    normalized.startsWith("prelude ") ||
    normalized.includes(" editor-prelude") ||
    normalized.includes(" prelude")
    ? "prelude"
    : "snippet";
}

function embeddedLeanTitle(info, ordinal) {
  const normalized = info.replaceAll(",", " ").trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : `block ${ordinal}`;
}

function parseEmbeddedLeanBlocks(source) {
  return parseLineCommentFencedBlocks(source, {
    kind: "lean",
    linePrefixes: ["//!", "///", "//"],
  }).map((block) => ({
    code: block.code,
    role: embeddedLeanRole(block.info ?? ""),
    sourceLine: block.sourceLine,
    title: embeddedLeanTitle(block.info ?? "", block.ordinal),
  }));
}

export function buildEmbeddedLeanDocumentFromSource(source, options = {}) {
  const blocks = parseEmbeddedLeanBlocks(source);
  const prelude = blocks.filter((block) => block.role === "prelude");
  const snippets = blocks.filter((block) => block.role !== "prelude");
  const lines = [];
  for (const moduleName of options.defaultImports ?? []) {
    lines.push(`import ${moduleName}`);
  }
  if (options.defaultImports?.length > 0) {
    lines.push("");
  }
  if (options.preamble?.length > 0) {
    lines.push(...options.preamble);
    lines.push("");
  }
  for (const block of [...prelude, ...snippets]) {
    lines.push(`/- ${block.title} from ${options.sourceName ?? "Rust source"}:${block.sourceLine} -/`);
    lines.push(...block.code.split("\n"));
    lines.push("");
  }
  if (options.postamble?.length > 0) {
    lines.push(...options.postamble);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function readFileOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function ensureEmbeddedLeanArtifacts(embeddedLeanPath, context) {
  await mkdir(dirname(embeddedLeanPath), { recursive: true });
  const nextDocument = context.sourcePath
    ? buildEmbeddedLeanDocumentFromSource(await readFile(context.sourcePath, "utf8"), context)
    : defaultEmbeddedLeanDocument(context);
  if (await readFileOrNull(embeddedLeanPath) !== nextDocument) {
    await writeFile(embeddedLeanPath, nextDocument, "utf8");
  }
}
