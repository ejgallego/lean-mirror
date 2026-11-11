import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "demo-setup-"));
  directories.push(directory);
  const log = join(directory, "commands");
  function command(name: string, body = "exit 0") {
    writeFileSync(join(directory, name), `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> "$SETUP_TEST_LOG"\n${body}\n`, { mode: 0o755 });
  }
  function run() {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory, SETUP_TEST_LOG: log };
    delete env.npm_execpath;
    return spawnSync(process.execPath, [resolve("scripts/setup-demo.mjs")], { env, encoding: "utf8" });
  }
  return { directory, command, run, commands: () => readFileSync(log, "utf8") };
}

test.skipIf(process.platform === "win32")("setup reports all missing installers before downloading anything", () => {
  const f = fixture();
  f.command("npm");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Install elan:");
  expect(result.stderr).toContain("Install rustup:");
  expect(f.commands()).not.toContain("ci");
});

test.skipIf(process.platform === "win32")("a failed toolchain install stops setup before replacing npm dependencies", () => {
  const f = fixture();
  f.command("elan");
  f.command("npm");
  f.command("rustup", 'if [ "$1" = "--version" ]; then exit 0; fi\nexit 42');
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("failed (42)");
  expect(result.stderr).toContain("rerun npm run demo:setup");
  expect(f.commands()).not.toContain("ci");
});

test("a failed demo launch releases its backend port", async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const f = fixture();
  const result = spawnSync(process.execPath, [resolve("scripts/run-demo.mjs")], {
    env: { ...process.env, PATH: f.directory, DEMO_BACKEND_PORT: String(address.port),
      DEMO_BACKEND_READY_TIMEOUT_MS: "5000", LEAN_DEMO_LEAN_ONLY: "1" },
    encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("lake is required");
  // Binding the same port proves that the child's listening socket was closed.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address.port, "127.0.0.1", resolve);
    });
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20_000);
