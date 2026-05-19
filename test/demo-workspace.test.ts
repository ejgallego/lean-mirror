import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  return { demoDir, workspace: createDemoWorkspace(demoDir) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("demo workspace backend", () => {
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
    });

    expect(result).toEqual({
      leanDocumentUri: workspace.uris.embeddedLeanUri,
      revision: 12,
    });
    expect(await readFile(workspace.paths.rustMainPath, "utf8")).toBe("fn changed() {}\n");
    expect(await workspace.readDocument(workspace.uris.embeddedLeanUri)).toBe("#check helperValue\n");
  });

  it("rejects document reads outside the demo workspace", async () => {
    const { demoDir, workspace } = await createFixture();
    const outsideUri = pathToFileURL(join(demoDir, "outside.lean")).toString();

    await expect(workspace.readDocument(outsideUri)).rejects.toMatchObject({
      code: "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE",
    });
  });
});
