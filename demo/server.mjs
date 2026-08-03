import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createDemoWorkspace } from "./server/demoWorkspace.mjs";
import { attachLspProcess, pipeServerStderr } from "./server/lspProcessBridge.mjs";
import {
  DemoRequestTooLargeError,
  assertSafeDemoBind,
  parseAllowedOrigins,
  parsePositiveInteger,
  readBoundedJsonBody,
  requestOriginAllowed,
} from "./server/security.mjs";
import {
  DEMO_ENDPOINTS,
  parseCreateRustSessionRequest,
  parseRustMainUpdateRequest,
  parseSwitchExampleRequest,
  parseUpdateRustDocumentRequest,
} from "./shared/demoProtocol.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = process.env.LEAN_DEMO_HOST ?? "127.0.0.1";
const port = Number(process.env.LEAN_DEMO_PORT ?? "7357");
const allowRemote = process.env.LEAN_DEMO_ALLOW_REMOTE === "1";
assertSafeDemoBind(host, allowRemote);
const frontendHost = process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.DEMO_FRONTEND_PORT ?? "5173";
const allowedOrigins = parseAllowedOrigins(process.env.LEAN_DEMO_ALLOWED_ORIGINS, [
  `http://${frontendHost}:${frontendPort}`,
  ...(frontendHost === "127.0.0.1" ? [`http://localhost:${frontendPort}`] : []),
]);
const maxBodyBytes = parsePositiveInteger(
  process.env.LEAN_DEMO_MAX_BODY_BYTES,
  1_048_576,
  "LEAN_DEMO_MAX_BODY_BYTES",
);
const maxWebSocketBytes = parsePositiveInteger(
  process.env.LEAN_DEMO_MAX_WEBSOCKET_BYTES,
  1_048_576,
  "LEAN_DEMO_MAX_WEBSOCKET_BYTES",
);
const maxLspProcesses = parsePositiveInteger(
  process.env.LEAN_DEMO_MAX_LSP_PROCESSES,
  8,
  "LEAN_DEMO_MAX_LSP_PROCESSES",
);
const demoWorkspace = createDemoWorkspace(__dirname, {
  cwd: process.cwd(),
  env: process.env,
  onStatusChange(status) {
    console.log(`[demo] ${status.message}`);
  },
});
let prepareError = null;
const preparePromise = demoWorkspace.prepare().catch((error) => {
  prepareError = error;
});

function websocketUrls() {
  return {
    rustMainWebsocketUrl: `ws://${host}:${port}/rust-main-lsp`,
    websocketUrl: `ws://${host}:${port}/lsp`,
  };
}

function withCorsHeaders(req, headers = {}) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  return {
    ...(origin && allowedOrigins.has(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  };
}

async function readValidatedJsonBody(req, res, parser, invalidMessage) {
  try {
    return parser(await readBoundedJsonBody(req, maxBodyBytes));
  } catch (error) {
    const tooLarge = error instanceof DemoRequestTooLargeError;
    res.writeHead(tooLarge ? 413 : 400, withCorsHeaders(req));
    res.end(tooLarge ? "Request body too large" : invalidMessage);
    return null;
  }
}

async function handleHttpRequest(req, res) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!requestOriginAllowed(origin, allowedOrigins)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Origin not allowed");
    return;
  }
  if (!req.url) {
    res.writeHead(400, withCorsHeaders(req));
    res.end("Missing URL");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, withCorsHeaders(req));
    res.end();
    return;
  }
  if (req.url === DEMO_ENDPOINTS.status) {
    res.writeHead(
      200,
      withCorsHeaders(req, {
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify(demoWorkspace.readPreparationStatus()));
    return;
  }
  if (req.url === DEMO_ENDPOINTS.session) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    res.writeHead(
      200,
      withCorsHeaders(req, {
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify(await demoWorkspace.readSession(websocketUrls())));
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.switchExample) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseSwitchExampleRequest,
      "Invalid switch-example payload",
    );
    if (!payload) return;
    try {
      await demoWorkspace.switchExample(payload.id);
    } catch (error) {
      res.writeHead(400, withCorsHeaders(req));
      res.end(error instanceof Error ? error.message : "Failed to switch example");
      return;
    }
    res.writeHead(204, withCorsHeaders(req));
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustSession) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseCreateRustSessionRequest,
      "Invalid rust-session payload",
    );
    if (!payload) return;
    const session = await demoWorkspace.createRustBlockSession(payload.key, payload.code);
    res.writeHead(
      200,
      withCorsHeaders(req, {
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
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustDocument) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseUpdateRustDocumentRequest,
      "Invalid rust-document payload",
    );
    if (!payload) return;
    await demoWorkspace.updateRustBlockDocument(payload.key, payload.code, payload.version);
    res.writeHead(204, withCorsHeaders(req));
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustMain) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseRustMainUpdateRequest,
      "Invalid rust-main payload",
    );
    if (!payload) return;
    if (payload.uri !== demoWorkspace.uris.rustMainUri) {
      res.writeHead(400, withCorsHeaders(req));
      res.end("Invalid rust-main payload");
      return;
    }
    const result = await demoWorkspace.updateRustMainDocument(payload);
    res.writeHead(
      200,
      withCorsHeaders(req, {
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify(result));
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.regenerateRustMain) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseRustMainUpdateRequest,
      "Invalid rust-main regeneration payload",
    );
    if (!payload) return;
    try {
      const result = await demoWorkspace.regenerateRustMainDocument(payload, websocketUrls());
      res.writeHead(
        200,
        withCorsHeaders(req, {
          "Content-Type": "application/json; charset=utf-8",
        }),
      );
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(
        500,
        withCorsHeaders(req, {
          "Content-Type": "text/plain; charset=utf-8",
        }),
      );
      res.end(error instanceof Error ? error.message : "Failed to regenerate Rust main workspace");
    }
    return;
  }
  if (req.url.startsWith(`${DEMO_ENDPOINTS.document}?`)) {
    await preparePromise;
    if (prepareError) {
      throw prepareError;
    }
    const url = new URL(req.url, `http://${host}:${port}`);
    const uri = url.searchParams.get("uri");
    if (!uri) {
      res.writeHead(400, withCorsHeaders(req));
      res.end("Missing uri parameter");
      return;
    }
    try {
      const text = await demoWorkspace.readDocument(uri);
      res.writeHead(
        200,
        withCorsHeaders(req, {
          "Content-Type": "application/json; charset=utf-8",
        }),
      );
      res.end(JSON.stringify({ uri, text }));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE") {
        res.writeHead(403, withCorsHeaders(req));
        res.end("URI outside demo workspace");
        return;
      }
      throw error;
    }
    return;
  }
  res.writeHead(
    404,
    withCorsHeaders(req, {
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
  res.end("Not found");
}

const httpServer = createServer((req, res) => {
  void handleHttpRequest(req, res).catch((error) => {
    console.error("[demo] request failed", error);
    res.writeHead(
      500,
      withCorsHeaders(req, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    );
    res.end("Internal server error");
  });
});

const wsServer = new WebSocketServer({
  maxPayload: maxWebSocketBytes,
  noServer: true,
});
let activeLspProcesses = 0;

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

function attachSpawnedLsp(connection, command, args, cwd) {
  activeLspProcesses += 1;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    activeLspProcesses = Math.max(0, activeLspProcesses - 1);
  };
  connection.once("close", release);

  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("error", () => connection.close());
  pipeServerStderr(child.stderr);
  attachLspProcess(connection, child);
}

wsServer.on("connection", (socket) => {
  attachSpawnedLsp(socket, "lake", ["env", "lean", "--server"], demoWorkspace.paths.workspaceDir);
});

httpServer.on("upgrade", (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!requestOriginAllowed(origin, allowedOrigins)) {
    rejectUpgrade(socket, "403 Forbidden", "Origin not allowed");
    return;
  }
  if (activeLspProcesses >= maxLspProcesses) {
    rejectUpgrade(socket, "503 Service Unavailable", "Too many active LSP sessions");
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
    const { rootPath } = demoWorkspace.rustBlockPaths(block);
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      attachSpawnedLsp(connection, "rust-analyzer", [], rootPath);
    });
    return;
  }
  if (url.pathname === "/rust-main-lsp") {
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      attachSpawnedLsp(connection, "rust-analyzer", [], demoWorkspace.paths.rustWorkspaceDir);
    });
    return;
  }
  socket.destroy();
});

httpServer.listen(port, host, () => {
  console.log(`Lean demo bridge listening on http://${host}:${port}`);
});
