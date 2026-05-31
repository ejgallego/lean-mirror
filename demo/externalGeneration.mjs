import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";

const generationSchemaVersion = 1;
const generationMetadataFilename = ".lean-demo-generation.json";
const generationRegistryFilename = ".lean-demo-generations.json";
const commentPrefixes = ["//!", "///", "//"];

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineEndOffset(source, lineStart, line) {
  return lineStart + line.length + (lineStart + line.length < source.length ? 1 : 0);
}

function parseCommentLine(line) {
  const orderedPrefixes = [...commentPrefixes].sort((left, right) => right.length - left.length);
  for (const prefix of orderedPrefixes) {
    const match = new RegExp(`^(\\s*)${escapeRegExp(prefix)}(\\s?)(.*)$`).exec(line);
    if (match) {
      return {
        content: match[3] ?? "",
      };
    }
  }
  return null;
}

function isLeanFenceHeader(content) {
  if (!content.startsWith("```")) {
    return false;
  }
  const rest = content.slice(3);
  if (!rest.startsWith("lean")) {
    return false;
  }
  const suffix = rest.slice("lean".length);
  return suffix.length === 0 || /^[\s,]/.test(suffix);
}

function parseEmbeddedLeanRanges(source) {
  const lines = source.split("\n");
  const ranges = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextOffset = lineEndOffset(source, offset, line);
    const parsed = parseCommentLine(line);
    if (!parsed || !isLeanFenceHeader(parsed.content.trim())) {
      offset = nextOffset;
      continue;
    }

    const from = offset;
    let endOffset = nextOffset;
    let foundEnd = false;

    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner] ?? "";
      const innerStart = endOffset;
      endOffset = lineEndOffset(source, innerStart, innerLine);
      const innerParsed = parseCommentLine(innerLine);
      if (!innerParsed) {
        break;
      }
      if (/^```\s*$/.test(innerParsed.content)) {
        foundEnd = true;
        index = inner;
        ranges.push({ from, to: endOffset });
        break;
      }
    }

    offset = foundEnd ? endOffset : nextOffset;
  }

  return ranges;
}

export function rustEmbeddedLeanHostFingerprint(source) {
  const ranges = parseEmbeddedLeanRanges(source);
  if (ranges.length === 0) {
    return source;
  }
  let cursor = 0;
  const parts = [];
  for (const range of ranges) {
    parts.push(source.slice(cursor, range.from));
    cursor = range.to;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function generationTargetDir(targetManifestPath) {
  const targetRoot = dirname(resolve(targetManifestPath));
  return join(targetRoot, "target", "anneal");
}

function generationRegistryPath(targetManifestPath) {
  return join(generationTargetDir(targetManifestPath), generationRegistryFilename);
}

export function generationMetadataPath(leanRoot) {
  return join(leanRoot, generationMetadataFilename);
}

export async function hasBuiltLeanArtifacts(leanRoot) {
  return pathExists(join(leanRoot, ".lake", "build", "lib", "lean", "Generated.olean"));
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    if (error && typeof error === "object" && error.code === "EISDIR") {
      return true;
    }
    throw error;
  }
}

async function isUsableLeanRoot(leanRoot) {
  const requiredPaths = [
    join(leanRoot, "generated"),
    join(leanRoot, "lakefile.lean"),
    join(leanRoot, "lean-toolchain"),
  ];
  const checks = await Promise.all(requiredPaths.map((path) => pathExists(path)));
  return checks.every(Boolean);
}

async function leanRootMatchesRustRelativePath(leanRoot, rustRelativePath) {
  const generatedDir = join(leanRoot, "generated");
  try {
    const entries = await readdir(generatedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const funsPath = join(generatedDir, entry.name, "Funs.lean");
      try {
        const funsText = await readFile(funsPath, "utf8");
        if (funsText.includes(`Source: '${rustRelativePath}'`)) {
          return true;
        }
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return false;
}

function expectedLeanRoot(info) {
  return normalizeLeanRoot(join(info.targetDir, info.key, "lean"));
}

function metadataMatchesInfo(metadata, info) {
  return metadata.key === info.key &&
    metadata.rustRelativePath === info.rustRelativePath &&
    metadata.leanRoot === expectedLeanRoot(info);
}

function normalizeLeanRoot(path) {
  return normalize(resolve(path));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readRegistry(path) {
  const data = await readJsonOrNull(path);
  if (!data || data.schemaVersion !== generationSchemaVersion || typeof data.generations !== "object") {
    return {
      generations: {},
      schemaVersion: generationSchemaVersion,
    };
  }
  return data;
}

async function writeRegistryEntry(registryPath, metadata) {
  const registry = await readRegistry(registryPath);
  registry.generations[metadata.key] = {
    buildCompletedAt: metadata.buildCompletedAt ?? null,
    leanRoot: metadata.leanRoot,
    registeredAt: metadata.registeredAt,
    rustRelativePath: metadata.rustRelativePath,
  };
  await writeJson(registryPath, registry);
}

export async function readAnnealGenerationMetadata(leanRoot) {
  const data = await readJsonOrNull(generationMetadataPath(leanRoot));
  if (
    !data ||
    data.schemaVersion !== generationSchemaVersion ||
    typeof data.key !== "string" ||
    typeof data.leanRoot !== "string"
  ) {
    return null;
  }
  return {
    annealArgs: Array.isArray(data.annealArgs) ? data.annealArgs : [],
    buildCompletedAt: typeof data.buildCompletedAt === "string" ? data.buildCompletedAt : null,
    key: data.key,
    leanRoot: normalizeLeanRoot(data.leanRoot),
    registeredAt: typeof data.registeredAt === "string" ? data.registeredAt : new Date(0).toISOString(),
    rustRelativePath: typeof data.rustRelativePath === "string" ? data.rustRelativePath : "",
    schemaVersion: generationSchemaVersion,
  };
}

export async function computeAnnealGenerationInfo(options) {
  const [rustSource, targetManifest, toolManifest] = await Promise.all([
    readFile(options.rustSourcePath, "utf8"),
    readFile(options.targetManifestPath, "utf8"),
    readFile(options.toolManifestPath, "utf8"),
  ]);
  const rustRelativePath = normalizeSlashes(options.rustRelativePath);
  const identity = {
    annealArgs: [...options.annealArgs],
    annealToolchainDir: options.annealToolchainDir ?? null,
    cargoHome: options.cargoHome ?? null,
    rustRelativePath,
    rustSource: rustEmbeddedLeanHostFingerprint(rustSource),
    schemaVersion: generationSchemaVersion,
    targetManifest,
    toolManifest,
    xdgCacheHome: options.xdgCacheHome ?? null,
  };
  return {
    annealArgs: [...options.annealArgs],
    key: createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24),
    registryPath: generationRegistryPath(options.targetManifestPath),
    rustRelativePath,
    targetDir: generationTargetDir(options.targetManifestPath),
  };
}

async function scanForGeneration(info) {
  try {
    const entries = await readdir(info.targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "cargo_target") {
        continue;
      }
      const leanRoot = join(info.targetDir, entry.name, "lean");
      const metadata = await readAnnealGenerationMetadata(leanRoot);
      if (!metadata || !metadataMatchesInfo(metadata, info)) {
        const normalizedLeanRoot = normalizeLeanRoot(leanRoot);
        if (
          !metadata &&
          normalizedLeanRoot === expectedLeanRoot(info) &&
          await isUsableLeanRoot(leanRoot) &&
          await leanRootMatchesRustRelativePath(leanRoot, info.rustRelativePath)
        ) {
          const recovered = buildMetadata(
            info,
            normalizedLeanRoot,
            await hasBuiltLeanArtifacts(leanRoot) ? new Date().toISOString() : null,
          );
          await writeJson(generationMetadataPath(recovered.leanRoot), recovered);
          await writeRegistryEntry(info.registryPath, recovered);
          return recovered;
        }
        continue;
      }
      if (!(await isUsableLeanRoot(leanRoot))) {
        continue;
      }
      await writeRegistryEntry(info.registryPath, metadata);
      return metadata;
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return null;
}

export async function findReusableAnnealGeneration(info) {
  const registry = await readRegistry(info.registryPath);
  const candidate = registry.generations?.[info.key];
  if (candidate && typeof candidate.leanRoot === "string") {
    const metadata = await readAnnealGenerationMetadata(candidate.leanRoot);
    if (metadata && metadataMatchesInfo(metadata, info) && await isUsableLeanRoot(metadata.leanRoot)) {
      return metadata;
    }
  }
  return scanForGeneration(info);
}

function buildMetadata(info, leanRoot, buildCompletedAt = null) {
  return {
    annealArgs: [...info.annealArgs],
    buildCompletedAt,
    key: info.key,
    leanRoot: normalizeLeanRoot(leanRoot),
    registeredAt: new Date().toISOString(),
    rustRelativePath: info.rustRelativePath,
    schemaVersion: generationSchemaVersion,
  };
}

export async function registerAnnealGeneration(info, leanRoot) {
  const metadata = buildMetadata(info, leanRoot);
  await writeJson(generationMetadataPath(metadata.leanRoot), metadata);
  await writeRegistryEntry(info.registryPath, metadata);
  return metadata;
}

export async function markAnnealGenerationBuilt(info, leanRoot) {
  const existing = await readAnnealGenerationMetadata(leanRoot);
  const metadata = existing
    ? {
        ...existing,
        buildCompletedAt: new Date().toISOString(),
      }
    : buildMetadata(info, leanRoot, new Date().toISOString());
  await writeJson(generationMetadataPath(metadata.leanRoot), metadata);
  await writeRegistryEntry(info.registryPath, metadata);
  return metadata;
}
