import { copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"],
  {
    cwd: root,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

copyFileSync(
  new URL("../node_modules/@leanprover/infoview/dist/index.css", import.meta.url),
  new URL("../dist/infoview.css", import.meta.url),
);
copyFileSync(
  new URL("../node_modules/@leanprover/infoview/dist/codicon.ttf", import.meta.url),
  new URL("../dist/codicon.ttf", import.meta.url),
);
