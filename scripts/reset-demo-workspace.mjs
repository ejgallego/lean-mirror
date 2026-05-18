import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const baselineDir = join(rootDir, "demo", "baseline");
const workspaceDir = join(rootDir, "demo", "workspace");
const rustBlocksDir = join(rootDir, "demo", "rust-blocks");

export async function resetDemoWorkspace() {
  await mkdir(workspaceDir, { recursive: true });
  await copyFile(join(baselineDir, "Main.rs"), join(workspaceDir, "Main.rs"));
  await copyFile(join(baselineDir, "RustSnippets.lean"), join(workspaceDir, "RustSnippets.lean"));
  await rm(rustBlocksDir, { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await resetDemoWorkspace();
}
