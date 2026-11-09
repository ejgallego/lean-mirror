import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import {
  attachLspProcess,
  pipeServerStderr,
} from "../../demo/server/lspProcessBridge.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.SNAPSHOT_DEMO_PORT ?? 5282);
const origin = `http://127.0.0.1:${port}`;
const plugin = resolve(
  root,
  ".lake/build/lib",
  process.platform === "darwin"
    ? "libsnapshotDisplay_DisplayProbe.dylib"
    : "libsnapshotDisplay_DisplayProbe.so",
);
await access(plugin); // Build first; never silently fall back to recorded data.
const source = await readFile(resolve(root, "Fixture.lean"), "utf8");
const vite = await createViteServer({
  configFile: false,
  root: resolve(root, "web"),
  server: {
    middlewareMode: true,
    hmr: false,
    fs: { allow: [resolve(root, "../..")] },
  },
  appType: "spa",
});
const server = createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}`) {
    res.writeHead(403).end();
    return;
  }
  if (req.url === "/session") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        source,
        uri: pathToFileURL(resolve(root, "Fixture.lean")).href,
        rootUri: pathToFileURL(root).href,
      }),
    );
  } else vite.middlewares(req, res);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const sessions = new Set();
server.on("upgrade", (req, socket, head) => {
  if (
    req.url !== "/lsp" ||
    req.headers.origin !== origin ||
    sessions.size >= 4
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (socket) => {
  const child = spawn(
    "lake",
    [
      "env",
      "lean",
      "--server",
      `--plugin=${plugin}`,
      "-DstderrAsMessages=false",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  pipeServerStderr(child.stderr);
  const session = attachLspProcess(socket, child, {
    killDelayMs: 5000,
    killEscalationMs: 1000,
  });
  sessions.add(session);
  child.once("close", () => sessions.delete(session));
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const session of sessions) session.shutdown();
  wss.close();
  server.close();
  await vite.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.listen(port, "127.0.0.1", () =>
  console.log(`Snapshot display demo: ${origin}`),
);
