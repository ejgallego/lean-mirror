import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const backendHost = process.env.MINIMAL_BACKEND_HOST ?? "127.0.0.1";
const backendPort = String(process.env.MINIMAL_BACKEND_PORT ?? "7457");
const frontendHost = process.env.MINIMAL_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = String(process.env.MINIMAL_FRONTEND_PORT ?? "5273");
const backendUrl = `http://${backendHost}:${backendPort}`;
const frontendUrl = `http://${frontendHost}:${frontendPort}`;
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const children = new Set();
let shuttingDown = false;
let finishRun;
const runFinished = new Promise((resolve) => {
  finishRun = resolve;
});

function spawnChild(command, args, env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    shell: false,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(
        `[minimal-example] ${command} exited unexpectedly (${code ?? signal ?? "unknown"}).`,
      );
      void shutdown(typeof code === "number" && code !== 0 ? code : 1);
    }
  });
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve(undefined);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, 3_000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await Promise.all([...children].map(stopChild));
  process.exitCode = code;
  finishRun?.();
}

async function waitForBackend(child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Minimal example backend exited before becoming ready.");
    }
    try {
      const response = await fetch(`${backendUrl}/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const status = await response.json();
        if (status?.phase === "ready") {
          return;
        }
        if (status?.phase === "failed") {
          throw new Error(status.message ?? "Minimal example backend preparation failed.");
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${backendUrl}${lastError ? `: ${lastError}` : ""}`,
  );
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

try {
  const backend = spawnChild(process.execPath, ["./demo/server.mjs"], {
    ...process.env,
    DEMO_FRONTEND_HOST: frontendHost,
    DEMO_FRONTEND_PORT: frontendPort,
    LEAN_DEMO_HOST: backendHost,
    LEAN_DEMO_PORT: backendPort,
  });
  await waitForBackend(backend);
  spawnChild(npxCommand, ["vite", "--config", "./examples/minimal/vite.config.ts"], {
    ...process.env,
    MINIMAL_FRONTEND_HOST: frontendHost,
    MINIMAL_FRONTEND_PORT: frontendPort,
    VITE_LEAN_BACKEND_URL: backendUrl,
  });
  console.log(`[minimal-example] Frontend: ${frontendUrl}`);
  console.log(`[minimal-example] Lean backend: ${backendUrl}`);
  await runFinished;
} catch (error) {
  console.error(`[minimal-example] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
