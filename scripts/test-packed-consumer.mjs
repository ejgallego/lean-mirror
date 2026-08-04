import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPlaywrightSuite } from "./run-playwright-suite.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("../test/packed-consumer", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cache =
  process.env.PACKED_CONSUMER_NPM_CACHE ??
  join(root, ".demo-cache", "packed-consumer-npm-cache");
const browserMode = process.argv.includes("--browser");

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      npm_config_cache: cache,
      NPM_CONFIG_CACHE: cache,
    },
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "codemirror-lean4-lsp-packed-"));
const consumer = join(temporaryRoot, "consumer");

function packageDocument(dependencies, scripts) {
  const document = {
    name: "codemirror-lean4-lsp-packed-consumer",
    private: true,
    type: "module",
    dependencies,
  };
  if (scripts) {
    document.scripts = scripts;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function expectNotInstalled(dependency) {
  try {
    await access(join(consumer, "node_modules", ...dependency.split("/")));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Core-only tarball install unexpectedly included optional peer ${dependency}`);
}

try {
  const packed = JSON.parse(run(
    npmCommand,
    [
      "pack",
      "--json",
      "--pack-destination",
      temporaryRoot,
      "--cache",
      cache,
    ],
    root,
  ));
  const entry = Array.isArray(packed) ? packed[0] : null;
  if (!entry || typeof entry.filename !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }
  const tarball = join(temporaryRoot, entry.filename);

  await mkdir(consumer);
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageDependency = pathToFileURL(tarball).href;
  await writeFile(
    join(consumer, "package.json"),
    packageDocument({
      "codemirror-lean4-lsp": packageDependency,
    }),
    "utf8",
  );
  await Promise.all([
    copyFile(join(fixture, "core-consumer.mjs"), join(consumer, "core-consumer.mjs")),
    copyFile(join(fixture, "consumer.mjs"), join(consumer, "consumer.mjs")),
    copyFile(join(fixture, "consumer.ts"), join(consumer, "consumer.ts")),
    copyFile(join(fixture, "tsconfig.json"), join(consumer, "tsconfig.json")),
  ]);
  if (browserMode) {
    await Promise.all([
      copyFile(join(fixture, "browser-main.ts"), join(consumer, "browser-main.ts")),
      copyFile(join(fixture, "index.html"), join(consumer, "index.html")),
      copyFile(join(fixture, "style.css"), join(consumer, "style.css")),
      copyFile(join(fixture, "vite.config.ts"), join(consumer, "vite.config.ts")),
      copyFile(join(fixture, "vite-env.d.ts"), join(consumer, "vite-env.d.ts")),
      copyFile(
        join(root, "examples", "minimal", "publicLeanEditor.ts"),
        join(consumer, "publicLeanEditor.ts"),
      ),
    ]);
  }

  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--cache",
      cache,
    ],
    consumer,
  );
  process.stdout.write(run(process.execPath, ["core-consumer.mjs"], consumer));
  await Promise.all([
    expectNotInstalled("@leanprover/infoview"),
    expectNotInstalled("react"),
    expectNotInstalled("react-dom"),
  ]);

  await writeFile(
    join(consumer, "package.json"),
    packageDocument({
      ...(browserMode ? {
        "@codemirror/state": rootPackage.dependencies["@codemirror/state"],
        "@codemirror/view": rootPackage.dependencies["@codemirror/view"],
      } : {}),
      "@leanprover/infoview": rootPackage.peerDependencies["@leanprover/infoview"],
      "codemirror-lean4-lsp": packageDependency,
      jsdom: rootPackage.devDependencies.jsdom,
      react: rootPackage.peerDependencies.react,
      "react-dom": rootPackage.peerDependencies["react-dom"],
      typescript: rootPackage.devDependencies.typescript,
      ...(browserMode ? {
        "vscode-languageserver-protocol":
          rootPackage.dependencies["vscode-languageserver-protocol"],
        vite: rootPackage.devDependencies.vite,
      } : {}),
    }, browserMode ? { preview: "vite preview" } : undefined),
    "utf8",
  );
  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--cache",
      cache,
    ],
    consumer,
  );
  run(
    process.execPath,
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumer,
  );
  const output = run(process.execPath, ["consumer.mjs"], consumer);
  process.stdout.write(output);
  if (browserMode) {
    const backendHost = process.env.PACKED_BACKEND_HOST ?? "127.0.0.1";
    const backendPort = process.env.PACKED_BACKEND_PORT ?? "7470";
    run(
      process.execPath,
      [join(consumer, "node_modules", "vite", "bin", "vite.js"), "build"],
      consumer,
      {
        VITE_LEAN_BACKEND_URL: `http://${backendHost}:${backendPort}`,
      },
    );
    const status = await runPlaywrightSuite({
      arguments: ["--config", "playwright.packed.config.ts"],
      environment: {
        PACKED_BROWSER_CONSUMER_ROOT: consumer,
      },
    });
    if (status !== 0) {
      throw new Error(`Packed browser Playwright suite failed with status ${status}`);
    }
  }
  console.log(
    browserMode
      ? "[packed-consumer] Isolated tarball install, types, runtime, production build, and real-Lean browser smoke passed"
      : "[packed-consumer] Isolated tarball install, types, runtime, and assets passed",
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
