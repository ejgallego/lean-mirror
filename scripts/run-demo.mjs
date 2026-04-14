import { spawn } from "node:child_process";

const children = [];
let shuttingDown = false;
const backendHost = process.env.DEMO_BACKEND_HOST ?? "127.0.0.1";
const backendPort = process.env.DEMO_BACKEND_PORT ?? "7357";
const frontendHost = process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.DEMO_FRONTEND_PORT ?? "5173";

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      shuttingDown = true;
      shutdown();
    }
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
  shutdown();
  process.exit(130);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  shutdown();
  process.exit(143);
});

start("backend", process.execPath, ["./demo/server.mjs"], {
  LEAN_DEMO_HOST: backendHost,
  LEAN_DEMO_PORT: backendPort,
});
start(process.platform === "win32" ? "frontend" : "frontend", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "demo:frontend"], {
  DEMO_FRONTEND_HOST: frontendHost,
  DEMO_FRONTEND_PORT: frontendPort,
  VITE_LEAN_DEMO_API: `http://${backendHost}:${backendPort}`,
});
