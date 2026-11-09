import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const rosettaCheckoutConfig = join(repositoryRoot, ".demo-cache", "rosetta-source.json");

export async function resolveRosettaSource(env = process.env) {
  if (env.LEAN_DEMO_ROSETTA_ROOT) return resolve(env.LEAN_DEMO_ROSETTA_ROOT);
  try {
    const config = JSON.parse(await readFile(rosettaCheckoutConfig, "utf8"));
    if (typeof config.root !== "string" || !config.root) throw new Error("Invalid Rosetta checkout configuration");
    return resolve(config.root);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return join(repositoryRoot, "demo", "rosetta", "vendor", "rosetta");
}

async function copySource(source, target, moduleDirectory = false) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  // Deleted or renamed checkout modules must disappear from the build too.
  // Keep Lake's caches and unrelated host files for incremental builds.
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const managed = entry.isDirectory()
      ? (entry.name === "Rosetta" || moduleDirectory) && !entry.name.startsWith(".")
      : entry.name.endsWith(".lean") || ["lakefile.toml", "lean-toolchain"].includes(entry.name);
    if (managed && !names.has(entry.name)) await rm(join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === "Rosetta" || moduleDirectory) && !entry.name.startsWith(".")) {
      await copySource(join(source, entry.name), join(target, entry.name), true);
    }
    else if (entry.isFile() && (entry.name.endsWith(".lean") || ["lakefile.toml", "lean-toolchain"].includes(entry.name))) {
      const data = await readFile(join(source, entry.name));
      const destination = join(target, entry.name);
      const existing = await readFile(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (!existing?.equals(data)) await writeFile(destination, data);
    }
  }
}

/** Build only a local snapshot; never write into the Rosetta source checkout. */
export async function prepareRosetta(env = process.env) {
  const source = await resolveRosettaSource(env);
  const target = join(repositoryRoot, ".demo-cache", "rosetta-host");
  try { await copySource(source, join(target, "rosetta")); }
  catch (error) { throw new Error(`Cannot prepare Rosetta from ${source}. Set LEAN_DEMO_ROSETTA_ROOT to its package directory.`, { cause: error }); }
  await copySource(join(repositoryRoot, "demo", "rosetta"), target);
  await writeFile(join(target, "lean-toolchain"), await readFile(join(source, "lean-toolchain")));
  await new Promise((resolveBuild, reject) => {
    const child = spawn("lake", ["build"], { cwd: target, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveBuild() : reject(new Error(`Rosetta host build failed (${code}).`)));
  });
  return join(target, ".lake", "build", "bin", "rosetta-bridge");
}
