import { spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const versoRoot = resolve(
  process.env.VERSO_MIRROR_ROOT ?? fileURLToPath(new URL("../../verso-mirror", import.meta.url)),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  accessSync(resolve(versoRoot, "package.json"));
} catch {
  throw new Error(
    `Verso consumer not found at ${versoRoot}. Set VERSO_MIRROR_ROOT to its checkout.`,
  );
}

for (const script of ["check", "test", "build"]) {
  const result = spawnSync(npmCommand, ["run", script], {
    cwd: versoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Verso consumer command npm run ${script} failed with status ${result.status ?? "unknown"}.`,
    );
  }
}

console.log(`[verso-consumer] Check, tests, and build passed in ${versoRoot}`);
