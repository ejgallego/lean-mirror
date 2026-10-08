import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const toolchain = readFileSync(new URL("../lean-toolchain", import.meta.url), "utf8").trim();
const demoToolchain = readFileSync(new URL("../demo/workspace/lean-toolchain", import.meta.url), "utf8").trim();
if (toolchain !== demoToolchain) {
  throw new Error(`Root and demo Lean toolchain pins must match: ${toolchain} versus ${demoToolchain}.`);
}
const expectedLeanVersion = /^leanprover\/lean4:v(.+)$/.exec(toolchain)?.[1];
if (!expectedLeanVersion) {
  throw new Error(`Cannot verify Lean version for toolchain ${toolchain}. Update the CI environment check.`);
}

// Integration tests may skip unavailable tools during focused local runs.
// The full CI command requires them, so a missing prerequisite cannot pass CI.
for (const command of ["lean", "lake", "rust-analyzer"]) {
  const result = spawnSync(command, ["--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} is required for npm run ci: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  const version = result.stdout.trim();
  if (command === "lean" && !version.includes(`version ${expectedLeanVersion},`)) {
    throw new Error(`Expected Lean ${expectedLeanVersion} from ${toolchain}, received: ${version}`);
  }
  console.log(`[check:environment] ${version}`);
}
