import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeAnnealGenerationInfo,
  findReusableAnnealGeneration,
  generationMetadataPath,
  hasBuiltLeanArtifacts,
  markAnnealGenerationBuilt,
  readAnnealGenerationMetadata,
  registerAnnealGeneration,
  rustEmbeddedLeanHostFingerprint,
} from "../demo/externalGeneration.mjs";
import { embeddedLeanHostFingerprint } from "../demo/src/embeddedLean.js";

const tempRoots: string[] = [];
const rootDir = process.cwd();
const testCacheDir = join(rootDir, ".demo-cache", "tests");

async function createProjectFixture() {
  await mkdir(testCacheDir, { recursive: true });
  const root = await mkdtemp(join(testCacheDir, "lean-demo-generation-"));
  tempRoots.push(root);
  const toolManifestPath = join(root, "anneal-tool", "Cargo.toml");
  const targetManifestPath = join(root, "anneal", "Cargo.toml");
  const rustSourcePath = join(root, "anneal", "examples", "demo.rs");

  await mkdir(join(root, "anneal-tool"), { recursive: true });
  await mkdir(join(root, "anneal", "examples"), { recursive: true });
  await writeFile(toolManifestPath, '[package]\nname = "cargo-anneal"\nversion = "0.1.0"\n', "utf8");
  await writeFile(targetManifestPath, '[package]\nname = "anneal-target"\nversion = "0.1.0"\n', "utf8");

  return {
    root,
    rustSourcePath,
    targetManifestPath,
    toolManifestPath,
  };
}

async function writeLeanRoot(leanRoot: string, sourceRelativePath?: string) {
  await mkdir(join(leanRoot, "generated"), { recursive: true });
  await writeFile(join(leanRoot, "generated", "Generated.lean"), "import Init\n", "utf8");
  if (sourceRelativePath) {
    await mkdir(join(leanRoot, "generated", "demo"), { recursive: true });
    await writeFile(join(leanRoot, "generated", "demo", "Funs.lean"), `-- Source: '${sourceRelativePath}'\n`, "utf8");
  }
  await writeFile(join(leanRoot, "lakefile.lean"), "import Lake\n", "utf8");
  await writeFile(join(leanRoot, "lean-toolchain"), "leanprover/lean4:stable\n", "utf8");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0, tempRoots.length).map((path) => rm(path, { force: true, recursive: true })));
});

describe("external Anneal generation helpers", () => {
  it("matches the editor-side Rust host fingerprint and ignores embedded Lean comment edits", async () => {
    const fixture = await createProjectFixture();
    const baseSource = [
      "/// ```lean, anneal, spec",
      "/// theorem spec : True := by",
      "///   exact True.intro",
      "/// ```",
      "pub fn demo(x: u32) -> u32 {",
      "    x + 1",
      "}",
      "",
    ].join("\n");

    await writeFile(fixture.rustSourcePath, baseSource, "utf8");
    const baseInfo = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    const commentOnlyEdit = baseSource.replace("True.intro", "trivial");
    expect(rustEmbeddedLeanHostFingerprint(commentOnlyEdit)).toBe(embeddedLeanHostFingerprint(commentOnlyEdit));
    await writeFile(fixture.rustSourcePath, commentOnlyEdit, "utf8");
    const commentOnlyInfo = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    const rustEdit = commentOnlyEdit.replace("x + 1", "x + 2");
    await writeFile(fixture.rustSourcePath, rustEdit, "utf8");
    const rustEditInfo = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    expect(commentOnlyInfo.key).toBe(baseInfo.key);
    expect(rustEditInfo.key).not.toBe(baseInfo.key);
  });

  it("reuses registered generations and persists build completion", async () => {
    const fixture = await createProjectFixture();
    await writeFile(
      fixture.rustSourcePath,
      [
        "pub fn demo(x: u32) -> u32 {",
        "    x + 1",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const info = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    const leanRoot = join(fixture.root, "anneal", "target", "anneal", info.key, "lean");
    await writeLeanRoot(leanRoot);

    const registered = await registerAnnealGeneration(info, leanRoot);
    expect(registered.buildCompletedAt).toBeNull();
    expect(await findReusableAnnealGeneration(info)).toMatchObject({
      key: info.key,
      leanRoot,
    });
    expect(await hasBuiltLeanArtifacts(leanRoot)).toBe(false);

    await mkdir(join(leanRoot, ".lake", "build", "lib", "lean"), { recursive: true });
    await writeFile(join(leanRoot, ".lake", "build", "lib", "lean", "Generated.olean"), "binary", "utf8");

    const built = await markAnnealGenerationBuilt(info, leanRoot);
    expect(built.buildCompletedAt).toBeTruthy();
    expect(await hasBuiltLeanArtifacts(leanRoot)).toBe(true);

    await unlink(info.registryPath);

    const scanned = await findReusableAnnealGeneration(info);
    expect(scanned).toMatchObject({
      buildCompletedAt: built.buildCompletedAt,
      key: info.key,
      leanRoot,
    });
    expect(generationMetadataPath(leanRoot)).toContain(".lean-demo-generation.json");
  });

  it("recovers missing metadata only from the expected keyed Lean root", async () => {
    const fixture = await createProjectFixture();
    await writeFile(
      fixture.rustSourcePath,
      [
        "pub fn demo(x: u32) -> u32 {",
        "    x + 1",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const info = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    const legacyLeanRoot = join(fixture.root, "anneal", "target", "anneal", "legacy", "lean");
    await writeLeanRoot(legacyLeanRoot, info.rustRelativePath);

    await expect(findReusableAnnealGeneration(info)).resolves.toBeNull();
    await expect(readAnnealGenerationMetadata(legacyLeanRoot)).resolves.toBeNull();

    const keyedLeanRoot = join(fixture.root, "anneal", "target", "anneal", info.key, "lean");
    await writeLeanRoot(keyedLeanRoot, info.rustRelativePath);

    await expect(findReusableAnnealGeneration(info)).resolves.toMatchObject({
      key: info.key,
      leanRoot: keyedLeanRoot,
    });
  });

  it("does not reuse a registry entry when the Lean root metadata belongs to another generation", async () => {
    const fixture = await createProjectFixture();
    await writeFile(
      fixture.rustSourcePath,
      [
        "pub fn demo(x: u32) -> u32 {",
        "    x + 1",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const currentInfo = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "demo", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });
    const staleInfo = await computeAnnealGenerationInfo({
      annealArgs: ["--example", "stale", "--allow-sorry"],
      rustRelativePath: "examples/demo.rs",
      rustSourcePath: fixture.rustSourcePath,
      targetManifestPath: fixture.targetManifestPath,
      toolManifestPath: fixture.toolManifestPath,
    });

    const leanRoot = join(fixture.root, "anneal", "target", "anneal", currentInfo.key, "lean");
    await writeLeanRoot(leanRoot);
    await registerAnnealGeneration(staleInfo, leanRoot);

    const registry = JSON.parse(await readFile(currentInfo.registryPath, "utf8"));
    registry.generations[currentInfo.key] = {
      buildCompletedAt: new Date().toISOString(),
      leanRoot,
      registeredAt: new Date().toISOString(),
      rustRelativePath: currentInfo.rustRelativePath,
    };
    await writeFile(currentInfo.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await expect(findReusableAnnealGeneration(currentInfo)).resolves.toBeNull();
  });
});
