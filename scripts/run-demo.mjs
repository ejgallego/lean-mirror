import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { readDemoConfig } from "./demo-config.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const demo = readDemoConfig(process.env);

process.env.DEMO_BACKEND_HOST = demo.backendHost;
process.env.DEMO_BACKEND_PORT = demo.backendPort;
process.env.DEMO_FRONTEND_HOST = demo.frontendHost;
process.env.DEMO_FRONTEND_PORT = demo.frontendPort;
process.env.VITE_LEAN_DEMO_API = demo.apiBase;

let backendChild = null;
let backendStopping = false;
let restartTimer = null;
let restartReason = null;
let restartPromise = Promise.resolve();
let shuttingDown = false;
let viteServer = null;
let watchReady = false;

function shortPath(path) {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function shouldRestartBridges(path) {
  const file = shortPath(path);
  if (
    file.startsWith("demo/rust-blocks/") ||
    file.startsWith("demo/dist/") ||
    file.startsWith("demo/workspace/.lake/") ||
    file.startsWith("demo/workspace/target/") ||
    file === "demo/workspace/Cargo.lock" ||
    file === "demo/workspace/Main.rs" ||
    file === "demo/workspace/RustSnippets.lean" ||
    file === "demo/workspace/lake-manifest.json" ||
    file.endsWith(".olean")
  ) {
    return false;
  }
  return (
    file === "demo/index.html" ||
    file === "demo/server.mjs" ||
    file.startsWith("demo/server/") ||
    file.startsWith("demo/shared/") ||
    file.startsWith("demo/src/") ||
    file.startsWith("demo/workspace/") ||
    file.startsWith("src/")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBackendStatus() {
  const response = await fetchWithTimeout(`${demo.backendUrl}/status`, 900);
  if (!response.ok) {
    return null;
  }
  const status = await response.json();
  if (!status || typeof status !== "object" || typeof status.message !== "string") {
    return null;
  }
  return {
    detail: typeof status.detail === "string" ? status.detail : "",
    message: status.message,
    phase: typeof status.phase === "string" ? status.phase : "preparing",
  };
}

async function waitForBackendReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = "";
  while (Date.now() < deadline) {
    try {
      const status = await fetchBackendStatus();
      if (status) {
        const message = status.detail ? `${status.message} ${status.detail}` : status.message;
        if (message !== lastMessage) {
          console.log(`[demo] ${message}`);
          lastMessage = message;
        }
        if (status.phase === "ready") {
          return;
        }
        if (status.phase === "failed") {
          throw new Error(`Demo backend failed: ${status.message}`);
        }
      } else {
        const response = await fetchWithTimeout(`${demo.backendUrl}/session`, 900);
        if (response.ok) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Demo backend failed:")) {
        throw error;
      }
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted && error instanceof Error && error.message !== lastMessage) {
        console.log(`[demo] Waiting for backend: ${error.message}`);
        lastMessage = error.message;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for demo backend at ${demo.backendUrl}`);
}

function spawnBackend() {
  const child = spawn(process.execPath, ["./demo/server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      LEAN_DEMO_HOST: demo.backendHost,
      LEAN_DEMO_PORT: demo.backendPort,
    },
    shell: false,
    stdio: "inherit",
  });

  backendChild = child;
  child.on("exit", (code, signal) => {
    const expected = shuttingDown || backendStopping || child !== backendChild;
    if (child === backendChild) {
      backendChild = null;
    }
    if (expected) {
      return;
    }
    console.error(
      `[demo] backend exited unexpectedly (${code ?? signal ?? "unknown"}); shutting down demo stack`,
    );
    void shutdown(typeof code === "number" ? code : 1);
  });
}

async function stopBackend() {
  const child = backendChild;
  if (!child) {
    return;
  }
  backendStopping = true;
  backendChild = null;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(undefined);
    };
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      finish();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
  backendStopping = false;
}

async function startBackend() {
  spawnBackend();
  await waitForBackendReady();
}

function scheduleBridgeRestart(reason) {
  if (shuttingDown) {
    return;
  }
  restartReason = reason;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    const currentReason = restartReason ?? "file change";
    restartReason = null;
    restartPromise = restartPromise
      .then(async () => {
        if (shuttingDown) {
          return;
        }
        console.log(`[demo] restarting LSP bridges after ${currentReason}`);
        await stopBackend();
        await startBackend();
        viteServer?.ws.send({ type: "full-reload" });
      })
      .catch((error) => {
        console.error(
          `[demo] failed to restart bridges: ${error instanceof Error ? error.message : String(error)}`,
        );
        return shutdown(1);
      });
  }, 120);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  try {
    await stopBackend();
    await viteServer?.close();
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => {
  void shutdown(130);
});

process.on("SIGTERM", () => {
  void shutdown(143);
});

await startBackend();

viteServer = await createServer({
  configFile: resolve(rootDir, "demo/vite.config.ts"),
});

viteServer.watcher.add([
  resolve(rootDir, "demo/server.mjs"),
  resolve(rootDir, "demo/server"),
  resolve(rootDir, "demo/shared"),
  resolve(rootDir, "demo/index.html"),
  resolve(rootDir, "demo/src"),
  resolve(rootDir, "demo/workspace"),
  resolve(rootDir, "src"),
]);

viteServer.watcher.on("all", (event, path) => {
  if (!watchReady) {
    return;
  }
  if (!shouldRestartBridges(path)) {
    return;
  }
  scheduleBridgeRestart(`${event} ${shortPath(path)}`);
});

await viteServer.listen();
watchReady = true;

console.log(`Demo frontend listening on ${demo.frontendUrl}`);
console.log(`Demo backend listening on ${demo.backendUrl}`);
