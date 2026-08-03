import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { computeAnnealGenerationInfo, registerAnnealGeneration } from "../demo/externalGeneration.mjs";
import { createDemoWorkspace, type DemoWorkspace } from "../demo/server/demoWorkspace.mjs";

const tempDirs: string[] = [];

async function createFixture(): Promise<{ demoDir: string; workspace: DemoWorkspace }> {
  const demoDir = await mkdtemp(join(tmpdir(), "lean-mirror-demo-"));
  tempDirs.push(demoDir);
  const workspaceDir = join(demoDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "Main.rs"), "fn main() {}\n", "utf8");
  await writeFile(join(workspaceDir, "Main.lean"), "import Helper\n", "utf8");
  await writeFile(join(workspaceDir, "Helper.lean"), "def helperValue := 1\n", "utf8");
  await writeFile(join(workspaceDir, "RustSnippets.lean"), "import Helper\n", "utf8");
  await writeFile(
    join(workspaceDir, "lakefile.toml"),
    [
      'name = "lean_mirror_demo_test"',
      'version = "0.1.0"',
      'defaultTargets = ["Helper"]',
      "",
      "[[lean_lib]]",
      'name = "Helper"',
      "",
      "[[lean_lib]]",
      'name = "RustSnippets"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspaceDir, "lean-toolchain"),
    await readFile(join(process.cwd(), "demo", "workspace", "lean-toolchain"), "utf8"),
    "utf8",
  );
  return { demoDir, workspace: createDemoWorkspace(demoDir) };
}

async function createExternalFixture(): Promise<{
  annealRoot: string;
  demoDir: string;
  rustPath: string;
  workspace: DemoWorkspace;
}> {
  const demoDir = await mkdtemp(join(tmpdir(), "lean-mirror-demo-"));
  tempDirs.push(demoDir);
  const checkoutRoot = join(demoDir, "zerocopy");
  const annealRoot = join(checkoutRoot, "anneal");
  const rustPath = join(annealRoot, "examples", "linked_list.rs");
  const leanRoot = join(demoDir, "lean-root");
  await mkdir(join(annealRoot, "examples"), { recursive: true });
  await mkdir(join(leanRoot, "generated"), { recursive: true });
  await writeFile(
    join(annealRoot, "Cargo.toml"),
    [
      "[package]",
      'name = "cargo-anneal"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(rustPath, "pub fn demo() {}\n", "utf8");
  const workspace = createDemoWorkspace(demoDir, {
    env: {
      ...process.env,
      LEAN_DEMO_ANNEAL_MANIFEST: join(annealRoot, "Cargo.toml"),
      LEAN_DEMO_EXAMPLE_PRESETS: "",
      LEAN_DEMO_EXAMPLE_SET: "",
      LEAN_DEMO_LEAN_ROOT: leanRoot,
      LEAN_DEMO_RUST_FILE: "anneal/examples/linked_list.rs",
      LEAN_DEMO_RUST_ROOT: checkoutRoot,
      LEAN_DEMO_SKIP_LEAN_BUILD: "1",
    },
  });
  await workspace.prepare();
  return { annealRoot, demoDir, rustPath, workspace };
}

async function createFakeLeanRoot(leanRoot: string): Promise<void> {
  await mkdir(join(leanRoot, "generated"), { recursive: true });
  await writeFile(join(leanRoot, "lakefile.lean"), "import Lake\nopen Lake DSL\npackage Generated\n", "utf8");
  await writeFile(join(leanRoot, "lean-toolchain"), "leanprover/lean4:nightly\n", "utf8");
}

async function registerFakeGeneration(options: {
  annealArgs: string[];
  rustPath: string;
  targetManifestPath: string;
  targetRoot: string;
  toolManifestPath: string;
}): Promise<void> {
  const info = await computeAnnealGenerationInfo({
    annealArgs: options.annealArgs,
    annealToolchainDir: process.env.ANNEAL_TOOLCHAIN_DIR,
    cargoHome: process.env.CARGO_HOME,
    rustRelativePath: relative(options.targetRoot, options.rustPath),
    rustSourcePath: options.rustPath,
    targetManifestPath: options.targetManifestPath,
    toolManifestPath: options.toolManifestPath,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
  });
  const leanRoot = join(info.targetDir, info.key, "lean");
  await createFakeLeanRoot(leanRoot);
  await registerAnnealGeneration(info, leanRoot);
}

async function createSwitchableExternalFixture(): Promise<{ workspace: DemoWorkspace }> {
  const demoDir = await mkdtemp(join(tmpdir(), "lean-mirror-demo-"));
  tempDirs.push(demoDir);
  const checkoutRoot = join(demoDir, "zerocopy");
  const annealRoot = join(checkoutRoot, "anneal");
  const toolRoot = join(demoDir, "anneal-tool");
  const targetManifestPath = join(annealRoot, "Cargo.toml");
  const toolManifestPath = join(toolRoot, "Cargo.toml");
  const examples = [
    {
      annealArgs: ["--example", "first"],
      id: "first",
      label: "first.rs",
      rustFile: "anneal/examples/first.rs",
      summary: "",
    },
    {
      annealArgs: ["--example", "second"],
      id: "second",
      label: "second.rs",
      rustFile: "anneal/examples/second.rs",
      summary: "",
    },
  ];

  await mkdir(join(annealRoot, "examples"), { recursive: true });
  await mkdir(toolRoot, { recursive: true });
  await writeFile(targetManifestPath, "[package]\nname = \"demo-target\"\nversion = \"0.1.0\"\n", "utf8");
  await writeFile(toolManifestPath, "[package]\nname = \"cargo-anneal\"\nversion = \"0.1.0\"\n", "utf8");

  for (const example of examples) {
    const rustPath = join(checkoutRoot, example.rustFile);
    await writeFile(rustPath, `pub fn ${example.id}() {}\n`, "utf8");
  }
  for (const example of examples) {
    const rustPath = join(checkoutRoot, example.rustFile);
    await registerFakeGeneration({
      annealArgs: example.annealArgs,
      rustPath,
      targetManifestPath,
      targetRoot: annealRoot,
      toolManifestPath,
    });
  }

  const workspace = createDemoWorkspace(demoDir, {
    env: {
      ...process.env,
      LEAN_DEMO_ANNEAL_MANIFEST: targetManifestPath,
      LEAN_DEMO_ANNEAL_TOOL_MANIFEST: toolManifestPath,
      LEAN_DEMO_EXAMPLE_PRESETS: JSON.stringify(examples),
      LEAN_DEMO_RUST_FILE: "anneal/examples/first.rs",
      LEAN_DEMO_RUST_ROOT: checkoutRoot,
      LEAN_DEMO_SKIP_LEAN_BUILD: "1",
    },
  });
  await workspace.prepare();
  return { workspace };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("demo workspace backend", () => {
  it("reports preparation status", async () => {
    const { workspace } = await createFixture();

    expect(workspace.readPreparationStatus().phase).toBe("idle");
    await workspace.prepare();
    const status = workspace.readPreparationStatus();
    const session = await workspace.readSession({
      rustMainWebsocketUrl: "ws://127.0.0.1:7357/rust-main-lsp",
      websocketUrl: "ws://127.0.0.1:7357/lsp",
    });

    expect(status.phase).toBe("ready");
    expect(status.message).toBe("Demo workspace ready.");
    expect(session.preparationStatus).toEqual(status);
  }, 30_000);

  it("builds session metadata from the workspace files", async () => {
    const { workspace } = await createFixture();

    const session = await workspace.readSession({
      rustMainWebsocketUrl: "ws://127.0.0.1:7357/rust-main-lsp",
      websocketUrl: "ws://127.0.0.1:7357/lsp",
    });

    expect(session.initialDoc).toBe("fn main() {}\n");
    expect(session.documentUri).toBe(workspace.uris.rustMainUri);
    expect(session.embeddedLeanDocumentUri).toBe(workspace.uris.embeddedLeanUri);
    expect(session.documents).toEqual([
      workspace.uris.rustMainUri,
      workspace.uris.embeddedLeanUri,
      workspace.uris.documentUri,
      workspace.uris.helperUri,
    ]);
  });

  it("creates Rust block sessions and ignores stale block updates", async () => {
    const { workspace } = await createFixture();
    const session = await workspace.createRustBlockSession("Rust Demo Widget", "pub fn old() {}\n");

    expect(session.slug).toBe("rust-demo-widget");
    expect(await readFile(session.documentPath, "utf8")).toBe("pub fn old() {}\n");

    await Promise.all([
      workspace.updateRustBlockDocument("Rust Demo Widget", "pub fn stale() {}\n", 1),
      workspace.updateRustBlockDocument("Rust Demo Widget", "pub fn fresh() {}\n", 2),
    ]);

    expect(await readFile(session.documentPath, "utf8")).toBe("pub fn fresh() {}\n");
  });

  it("updates the Rust driver and generated Lean snippet document", async () => {
    const { workspace } = await createFixture();

    const result = await workspace.updateRustMainDocument({
      code: "fn changed() {}\n",
      leanDocument: "#check helperValue\n",
      revision: 12,
      uri: workspace.uris.rustMainUri,
    });

    expect(result).toEqual({
      leanDocumentUri: workspace.uris.embeddedLeanUri,
      revision: 12,
    });
    expect(await readFile(workspace.paths.rustMainPath, "utf8")).toBe("fn changed() {}\n");
    expect(await workspace.readDocument(workspace.uris.embeddedLeanUri)).toBe("#check helperValue\n");
  });

  it("refreshes the embedded Lean document from Rust comments during preparation", async () => {
    const { workspace } = await createFixture();
    await writeFile(
      workspace.paths.rustMainPath,
      [
        "fn main() {}",
        "",
        "/// ```lean demo-check",
        "/// #check Nat.pred",
        "/// ```",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(workspace.paths.workspaceDir, "RustSnippets.lean"), "#check stale\n", "utf8");

    await workspace.prepare();

    const embeddedLean = await workspace.readDocument(workspace.uris.embeddedLeanUri);
    expect(embeddedLean).toContain("#check Nat.pred");
    expect(embeddedLean).not.toContain("#check stale");
  });

  it("rejects document reads outside the demo workspace", async () => {
    const { demoDir, workspace } = await createFixture();
    const outsideUri = pathToFileURL(join(demoDir, "outside.lean")).toString();

    await expect(workspace.readDocument(outsideUri)).rejects.toMatchObject({
      code: "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE",
    });
  });

  it("roots external Rust sessions at the manifest package containing the selected file", async () => {
    const { annealRoot, rustPath, workspace } = await createExternalFixture();
    const session = await workspace.readSession({
      rustMainWebsocketUrl: "ws://127.0.0.1:7357/rust-main-lsp",
      websocketUrl: "ws://127.0.0.1:7357/lsp",
    });

    expect(workspace.paths.rustWorkspaceDir).toBe(annealRoot);
    expect(session.documentUri).toBe(pathToFileURL(rustPath).toString());
    expect(session.rustRootUri).toBe(pathToFileURL(annealRoot).toString());
    expect(await workspace.readDocument(session.documentUri)).toBe("pub fn demo() {}\n");
  });

  it("reports ready status after switching external examples", async () => {
    const { workspace } = await createSwitchableExternalFixture();

    await workspace.switchExample("second");
    const status = workspace.readPreparationStatus();
    const session = await workspace.readSession({
      rustMainWebsocketUrl: "ws://127.0.0.1:7357/rust-main-lsp",
      websocketUrl: "ws://127.0.0.1:7357/lsp",
    });

    expect(status.phase).toBe("ready");
    expect(status.message).toBe("second.rs ready.");
    expect(session.activeExampleId).toBe("second");
    expect(session.preparationStatus?.phase).toBe("ready");
  });
});
