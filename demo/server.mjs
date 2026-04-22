import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = process.env.LEAN_DEMO_HOST ?? "127.0.0.1";
const port = Number(process.env.LEAN_DEMO_PORT ?? "7357");
const workspaceDir = join(__dirname, "workspace");
const rustBlocksDir = join(__dirname, "rust-blocks");
const documentPath = join(workspaceDir, "Main.lean");
const helperPath = join(workspaceDir, "Helper.lean");
const rootUri = pathToFileURL(workspaceDir).toString();
const documentUri = pathToFileURL(documentPath).toString();
const helperUri = pathToFileURL(helperPath).toString();

const ignorableClosePatterns = [
  /Watchdog error: Cannot read LSP (?:message|notification): Stream was closed/,
  /client exited without proper shutdown sequence/,
];

function ensureDemoArtifacts() {
  const result = spawnSync("lake", ["build"], {
    cwd: workspaceDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build demo/workspace with lake build\n${result.stderr ?? result.stdout ?? ""}`.trim(),
    );
  }
}

function withCorsHeaders(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  };
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "embedded-rust";
}

function rustBlockPaths(key) {
  const slug = slugify(key);
  const rootPath = join(rustBlocksDir, slug);
  const documentPath = join(rootPath, "src", "lib.rs");
  return { documentPath, rootPath, slug };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ensureRustBlockWorkspace(key, code) {
  const { documentPath, rootPath, slug } = rustBlockPaths(key);
  const crateName = "widget";
  await mkdir(join(rootPath, "src"), { recursive: true });
  await writeFile(
    join(rootPath, "Cargo.toml"),
    [
      "[package]",
      `name = "${crateName}"`,
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
      "[dependencies]",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(documentPath, code, "utf8");
  return {
    documentPath,
    documentUri: pathToFileURL(documentPath).toString(),
    rootPath,
    rootUri: pathToFileURL(rootPath).toString(),
    slug,
  };
}

async function updateRustBlockDocument(key, code) {
  const { documentPath } = rustBlockPaths(key);
  await writeFile(documentPath, code, "utf8");
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, withCorsHeaders());
    res.end("Missing URL");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, withCorsHeaders());
    res.end();
    return;
  }
  if (req.url === "/session") {
    const initialDoc = await readFile(documentPath, "utf8");
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(
      JSON.stringify({
        rootUri,
        documentUri,
        documents: [documentUri, helperUri],
        initialDoc,
        websocketUrl: `ws://${host}:${port}/lsp`,
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/rust-session") {
    const payload = await readJsonBody(req);
    if (!payload?.key || typeof payload.key !== "string" || typeof payload.code !== "string") {
      res.writeHead(400, withCorsHeaders());
      res.end("Invalid rust-session payload");
      return;
    }
    const session = await ensureRustBlockWorkspace(payload.key, payload.code);
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(
      JSON.stringify({
        documentUri: session.documentUri,
        rootUri: session.rootUri,
        websocketUrl: `ws://${host}:${port}/rust-lsp?block=${encodeURIComponent(session.slug)}`,
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/rust-document") {
    const payload = await readJsonBody(req);
    if (!payload?.key || typeof payload.key !== "string" || typeof payload.code !== "string") {
      res.writeHead(400, withCorsHeaders());
      res.end("Invalid rust-document payload");
      return;
    }
    await updateRustBlockDocument(payload.key, payload.code);
    res.writeHead(204, withCorsHeaders());
    res.end();
    return;
  }
  if (req.url.startsWith("/document?")) {
    const url = new URL(req.url, `http://${host}:${port}`);
    const uri = url.searchParams.get("uri");
    if (!uri) {
      res.writeHead(400, withCorsHeaders());
      res.end("Missing uri parameter");
      return;
    }
    const path = fileURLToPath(uri);
    if (!path.startsWith(`${workspaceDir}/`) && path !== workspaceDir) {
      res.writeHead(403, withCorsHeaders());
      res.end("URI outside demo workspace");
      return;
    }
    const text = await readFile(path, "utf8");
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify({ uri, text }));
    return;
  }
  res.writeHead(
    404,
    withCorsHeaders({
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
  res.end("Not found");
});

const wsServer = new WebSocketServer({ noServer: true });

function forwardLspFrames(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Malformed LSP header: ${header}`);
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onMessage(body);
    }
  });
}

function pipeServerStderr(stream, state) {
  let buffer = "";
  let skipBlock = false;

  function emit(line) {
    const text = line.replace(/\r$/, "");
    if (skipBlock) {
      if (text.trim().length === 0) {
        skipBlock = false;
      }
      return;
    }
    if (ignorableClosePatterns.some((pattern) => pattern.test(text))) {
      if (text.includes("client exited without proper shutdown sequence")) {
        skipBlock = true;
      }
      return;
    }
    if (text.trim().length === 0) {
      return;
    }
    console.error(text);
  }

  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      emit(buffer);
      buffer = "";
    }
  });
}

function sendLspFrame(stream, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function noteClientLspMessage(state, payload) {
  try {
    const message = JSON.parse(payload.toString("utf8"));
    if (message && typeof message === "object" && message.method === "initialized") {
      state.initialized = true;
    }
  } catch {}
}

function requestGracefulShutdown(child, state) {
  if (state.shutdownSent || child.killed || !state.initialized) {
    return;
  }
  state.shutdownSent = true;
  try {
    sendLspFrame(child.stdin, {
      jsonrpc: "2.0",
      id: 1_000_000,
      method: "shutdown",
      params: null,
    });
    setTimeout(() => {
      if (child.killed) {
        return;
      }
      try {
        sendLspFrame(child.stdin, {
          jsonrpc: "2.0",
          method: "exit",
          params: null,
        });
        child.stdin.end();
      } catch {}
    }, 25);
  } catch {}
}

wsServer.on("connection", (socket) => {
  const lean = spawn("lake", ["env", "lean", "--server"], {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { expectedClose: false, initialized: false, shutdownSent: false };
  pipeServerStderr(lean.stderr, state);

  forwardLspFrames(lean.stdout, (message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  });

  socket.on("message", (message) => {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8");
    noteClientLspMessage(state, payload);
    lean.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    lean.stdin.write(payload);
  });

  const shutdown = () => {
    state.expectedClose = true;
    requestGracefulShutdown(lean, state);
    if (!lean.killed) {
      setTimeout(() => {
        if (!lean.killed) {
          lean.kill();
        }
      }, 120);
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  socket.on("close", shutdown);
  socket.on("error", shutdown);
  lean.on("exit", () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
});

function attachLspProcess(
  socket,
  child,
  state = { expectedClose: false, initialized: false, shutdownSent: false },
) {
  forwardLspFrames(child.stdout, (message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  });

  socket.on("message", (message) => {
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8");
    noteClientLspMessage(state, payload);
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
  });

  const shutdown = () => {
    state.expectedClose = true;
    requestGracefulShutdown(child, state);
    if (!child.killed) {
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, 120);
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  socket.on("close", shutdown);
  socket.on("error", shutdown);
  child.on("exit", () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
}

httpServer.on("upgrade", (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, `http://${host}:${port}`);
  if (url.pathname === "/lsp") {
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      wsServer.emit("connection", connection, req);
    });
    return;
  }
  if (url.pathname === "/rust-lsp") {
    const block = url.searchParams.get("block");
    if (!block) {
      socket.destroy();
      return;
    }
    const { rootPath } = rustBlockPaths(block);
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      const rustAnalyzer = spawn("rust-analyzer", [], {
        cwd: rootPath,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const state = { expectedClose: false, initialized: false, shutdownSent: false };
      pipeServerStderr(rustAnalyzer.stderr, state);
      attachLspProcess(connection, rustAnalyzer, state);
    });
    return;
  }
  socket.destroy();
});

ensureDemoArtifacts();

httpServer.listen(port, host, () => {
  console.log(`Lean demo bridge listening on http://${host}:${port}`);
});
