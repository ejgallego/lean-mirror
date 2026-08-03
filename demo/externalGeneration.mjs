import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { lineCommentFencedHostFingerprint } from "./shared/embeddedLineComments.mjs";

const generationSchemaVersion = 2;
const generationMetadataFilename = ".lean-demo-generation.json";
const generationRegistryFilename = ".lean-demo-generations.json";

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

const ignoredIdentityDirectories = new Set([
  ".demo-cache",
  ".git",
  ".lake",
  "node_modules",
  "target",
]);

function hashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runGit(cwd, args, encoding = null) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

async function gitProjectIdentity(path, excludedPaths) {
  const directory = dirname(resolve(path));
  const rootOutput = runGit(directory, ["rev-parse", "--show-toplevel"], "utf8");
  if (typeof rootOutput !== "string") {
    return null;
  }
  const root = rootOutput.trim();
  const relativePath = normalizeSlashes(relative(root, resolve(path)));
  if (runGit(root, ["ls-files", "--error-unmatch", "--", relativePath]) === null) {
    return null;
  }

  const excludedRelativePaths = new Set(
    excludedPaths
      .map((excluded) => relative(root, resolve(excluded)))
      .filter((excluded) => !isAbsolute(excluded) && excluded !== ".." && !excluded.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
      .map(normalizeSlashes),
  );

  const trackedOutput = runGit(root, ["ls-files", "-s", "-z"]);
  const diffArgs = ["diff", "--binary", "--no-ext-diff", "--", "."];
  for (const excluded of excludedRelativePaths) {
    diffArgs.push(`:(exclude)${excluded}`);
  }
  const diff = runGit(root, diffArgs);
  const untrackedOutput = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!trackedOutput || !diff || !untrackedOutput) {
    return null;
  }

  const trackedEntries = trackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !excludedRelativePaths.has(normalizeSlashes(entry.slice(entry.indexOf("\t") + 1))))
    .sort();
  const untrackedPaths = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => !excludedRelativePaths.has(normalizeSlashes(path)))
    .sort();
  const untrackedParts = [];
  for (const relative of untrackedPaths) {
    untrackedParts.push(relative, await readFile(join(root, relative)));
  }
  return hashParts(["git-project-v1", ...trackedEntries, diff, ...untrackedParts]);
}

async function directoryIdentity(root, excludedPaths, current = root, parts = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredIdentityDirectories.has(entry.name)) {
      continue;
    }
    const path = join(current, entry.name);
    if (excludedPaths.has(resolve(path))) {
      continue;
    }
    const relative = normalizeSlashes(path.slice(root.length + 1));
    if (entry.isDirectory()) {
      await directoryIdentity(root, excludedPaths, path, parts);
    } else if (entry.isSymbolicLink()) {
      parts.push(relative, await readlink(path));
    } else if (entry.isFile()) {
      parts.push(relative, await readFile(path));
    }
  }
  return hashParts(["directory-v1", ...parts]);
}

async function projectIdentity(path, excludedPaths = []) {
  const gitIdentity = await gitProjectIdentity(path, excludedPaths);
  if (gitIdentity) {
    return gitIdentity;
  }
  return directoryIdentity(
    dirname(resolve(path)),
    new Set(excludedPaths.map((excluded) => resolve(excluded))),
  );
}

export function rustEmbeddedLeanHostFingerprint(source) {
  return lineCommentFencedHostFingerprint(source, {
    kind: "lean",
    linePrefixes: ["//!", "///", "//"],
  });
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
  const projectIdentities = new Map();
  const projectIdentityOnce = (path, excludedPaths = []) => {
    const key = JSON.stringify([
      resolve(path),
      ...excludedPaths.map((excluded) => resolve(excluded)).sort(),
    ]);
    let identity = projectIdentities.get(key);
    if (!identity) {
      identity = projectIdentity(path, excludedPaths);
      projectIdentities.set(key, identity);
    }
    return identity;
  };
  const [rustSource, targetManifest, toolManifest, targetProject, toolProject, toolchainProject] = await Promise.all([
    readFile(options.rustSourcePath, "utf8"),
    readFile(options.targetManifestPath, "utf8"),
    readFile(options.toolManifestPath, "utf8"),
    projectIdentityOnce(options.targetManifestPath, [options.rustSourcePath]),
    projectIdentityOnce(options.toolManifestPath, [options.rustSourcePath]),
    options.annealToolchainDir
      ? projectIdentityOnce(join(options.annealToolchainDir, "lean-toolchain"))
      : null,
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
    targetProject,
    toolManifest,
    toolProject,
    toolchainProject,
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
