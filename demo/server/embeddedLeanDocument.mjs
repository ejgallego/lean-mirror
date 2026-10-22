import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { renderEmbeddedLeanDocument } from "../shared/embeddedLeanDocument.mjs";

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

export function buildEmbeddedLeanDocumentFromSource(source, options = {}) {
  return renderEmbeddedLeanDocument(source, options).doc;
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
