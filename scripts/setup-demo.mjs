import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = fileURLToPath(new URL("../demo/workspace", import.meta.url));

async function run(command, args, { cwd = root, quiet = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: quiet ? "ignore" : "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}).`));
    });
  });
}

async function main() {
  // Match Vite's runtime requirement before downloading tools or dependencies.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major === 20 && minor >= 19 || major === 22 && minor >= 12 || major >= 24)) {
    throw new Error("Install Node.js 24 LTS, then rerun npm run demo:setup.");
  }
  console.log("[setup] Checking prerequisites…");
  const missing = [];
  for (const [command, hint] of [
    ["elan", "Install elan: https://github.com/leanprover/elan#installation"],
    ["rustup", "Install rustup: https://rustup.rs/"],
    ["npm", "Install Node.js 24 LTS (including npm): https://nodejs.org/"],
  ]) {
    try { await run(command, ["--version"], { quiet: true }); }
    catch { missing.push(`${hint}\nMake sure ${command} is on PATH.`); }
  }
  if (missing.length) throw new Error(missing.join("\n\n"));

  const lean = (await readFile(new URL("../lean-toolchain", import.meta.url), "utf8")).trim();
  const rustConfig = await readFile(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
  const rust = /^channel = "([^"]+)"$/m.exec(rustConfig)?.[1];
  if (!rust) throw new Error("Missing Rust channel in rust-toolchain.toml.");
  console.log(`[setup] Installing Lean (${lean})…`);
  await run("elan", ["run", "--install", lean, "lean", "--version"]);
  console.log(`[setup] Installing Rust ${rust} and language-server components…`);
  await run("rustup", ["toolchain", "install", rust, "--no-self-update", "--profile", "minimal",
    "--component", "rust-analyzer", "--component", "rust-src", "--component", "rustfmt"]);

  console.log("[setup] Installing locked JavaScript dependencies…");
  // Use npm's own CLI when invoked by npm; avoid shell quoting and platform shims.
  if (process.env.npm_execpath) await run(process.execPath, [process.env.npm_execpath, "ci"]);
  else await run("npm", ["ci"]);

  console.log("[setup] Building the Lean examples…");
  await run("lake", ["build", "Helper", "RustComment", "AeneasDemo", "RustSnippets"], { cwd: workspace });
  console.log("[setup] Building the Rosetta language-server host…");
  const { prepareRosetta } = await import("../demo/server/rosetta.mjs");
  await prepareRosetta();
  console.log("\n[setup] Ready! Run npm run demo, then open:\n" +
    "  Rust in Lean: http://127.0.0.1:5173/\n" +
    "  Lean in Rust: http://127.0.0.1:5173/?mode=rust");
}

main().catch(error => {
  console.error(`\n[setup] ${error.message}\nFix the problem above, then rerun npm run demo:setup.`);
  process.exitCode = 1;
});
