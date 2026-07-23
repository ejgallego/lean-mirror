import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const root = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCache =
  process.env.PACK_CHECK_NPM_CACHE ??
  join(tmpdir(), "codemirror-lean4-lsp-npm-cache");

function fail(message) {
  console.error(`[pack:check] ${message}`);
  process.exit(1);
}

const demoOnlyDependencies = [
  "@codemirror/lint",
  "@codemirror/stream-parser",
  "@leanprover/infoview",
  "marked",
  "react",
  "react-dom",
];
for (const dependency of demoOnlyDependencies) {
  if (packageJson.dependencies?.[dependency]) {
    fail(`Demo-only dependency ${dependency} must not be published as a runtime dependency`);
  }
}

for (const dependency of ["@leanprover/infoview", "react", "react-dom"]) {
  if (
    !packageJson.peerDependencies?.[dependency] ||
    packageJson.peerDependenciesMeta?.[dependency]?.optional !== true
  ) {
    fail(`Optional infoview dependency ${dependency} must be declared as an optional peer`);
  }
}

const pack =
  process.platform === "win32"
    ? spawnSync(npmCommand, ["pack", "--json", "--dry-run", "--cache", npmCache], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          NPM_CONFIG_CACHE: npmCache,
        },
      })
    : spawnSync(
        "/bin/bash",
        [
          "-lc",
          `npm_config_cache=${JSON.stringify(npmCache)} ${JSON.stringify(npmCommand)} pack --json --dry-run --cache ${JSON.stringify(npmCache)}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: npmCache,
            NPM_CONFIG_CACHE: npmCache,
          },
        },
      );

if (pack.status !== 0) {
  process.stderr.write(pack.stderr ?? "");
  fail("npm pack --dry-run failed");
}

let result;
try {
  result = JSON.parse(pack.stdout);
} catch (error) {
  fail(`Could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
}

const entry = Array.isArray(result) ? result[0] : null;
if (!entry || !Array.isArray(entry.files)) {
  fail("npm pack output did not include file metadata");
}

const packedFiles = new Set(entry.files.map((file) => file.path));
const disallowedPrefixes = [
  ".github/",
  "demo/",
  "node_modules/",
  "scripts/",
  "src/",
  "test/",
];
const disallowedFiles = [
  "playwright.config.ts",
  "tsconfig.build.json",
  "tsconfig.json",
  "vitest.config.ts",
];

for (const file of packedFiles) {
  if (disallowedPrefixes.some((prefix) => file.startsWith(prefix))) {
    fail(`Packed tarball unexpectedly contains ${file}`);
  }
  if (disallowedFiles.includes(file)) {
    fail(`Packed tarball unexpectedly contains ${file}`);
  }
}

const requiredFiles = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/codemirror.js",
  "dist/codemirror.d.ts",
  "dist/infoview.js",
  "dist/infoview.d.ts",
  "dist/infoview.css",
  "dist/codicon.ttf",
]);

for (const file of requiredFiles) {
  if (!packedFiles.has(file)) {
    fail(`Packed tarball is missing required file ${file}`);
  }
}

const exportedTargets = new Set();

function collectTargets(value) {
  if (typeof value === "string") {
    if (value.startsWith("./")) {
      exportedTargets.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const nested of Object.values(value)) {
    collectTargets(nested);
  }
}

collectTargets(packageJson.main);
collectTargets(packageJson.module);
collectTargets(packageJson.types);
collectTargets(packageJson.exports);
collectTargets(packageJson.typesVersions);

for (const target of exportedTargets) {
  if (!packedFiles.has(target) && target !== "package.json") {
    fail(`Export target ${target} is missing from the packed tarball`);
  }
}

console.log(`[pack:check] Verified ${packedFiles.size} packed files`);
