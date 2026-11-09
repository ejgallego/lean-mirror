import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { rosettaCheckoutConfig } from "../demo/server/rosetta.mjs";

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error("Usage: npm run demo:rosetta:checkout -- /path/to/packages/rosetta | --reset");
if (path === "--reset") {
  await rm(rosettaCheckoutConfig, { force: true });
  console.log("Rosetta uses the bundled fallback. Restart the demo to apply.");
} else {
  const root = resolve(path);
  await Promise.all([readFile(join(root, "Rosetta.lean")), readFile(join(root, "lakefile.toml")), readFile(join(root, "lean-toolchain"))]);
  await mkdir(dirname(rosettaCheckoutConfig), { recursive: true });
  await writeFile(rosettaCheckoutConfig, JSON.stringify({ root }, null, 2) + "\n");
  console.log(`Rosetta development checkout: ${root}\nRestart the demo to apply. Source edits will rebuild and reload it.`);
}
