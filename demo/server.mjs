import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createDemoWorkspace } from "./server/demoWorkspace.mjs";
import { attachLspProcess, pipeServerStderr } from "./server/lspProcessBridge.mjs";
import {
  DEMO_ENDPOINTS,
  parseCreateRustSessionRequest,
  parseRustMainUpdateRequest,
  parseUpdateRustDocumentRequest,
} from "./shared/demoProtocol.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = process.env.LEAN_DEMO_HOST ?? "127.0.0.1";
const port = Number(process.env.LEAN_DEMO_PORT ?? "7357");
const demoWorkspace = createDemoWorkspace(__dirname, {
  onStatusChange(status) {
    console.log(`[demo] ${status.message}`);
  },
});
let prepareError = null;
const preparePromise = demoWorkspace.prepare().catch((error) => {
  prepareError = error;
});

function withCorsHeaders(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readValidatedJsonBody(req, res, parser, invalidMessage) {
  try {
    return parser(await readJsonBody(req));
  } catch {
    res.writeHead(400, withCorsHeaders());
    res.end(invalidMessage);
    return null;
  }
}

async function ensureWorkspacePrepared() {
  await preparePromise;
  if (prepareError) {
    throw prepareError;
  }
}

async function handleHttpRequest(req, res) {
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
  if (req.url === DEMO_ENDPOINTS.status) {
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify(demoWorkspace.readPreparationStatus()));
    return;
  }
  if (req.url === DEMO_ENDPOINTS.session) {
    await ensureWorkspacePrepared();
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(
      JSON.stringify(
        await demoWorkspace.readSession({
          rustMainWebsocketUrl: `ws://${host}:${port}/rust-main-lsp`,
          websocketUrl: `ws://${host}:${port}/lsp`,
        }),
      ),
    );
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustSession) {
    await ensureWorkspacePrepared();
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
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustDocument) {
    await ensureWorkspacePrepared();
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseUpdateRustDocumentRequest,
      "Invalid rust-document payload",
    );
    if (!payload) return;
    await demoWorkspace.updateRustBlockDocument(payload.key, payload.code, payload.version);
    res.writeHead(204, withCorsHeaders());
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === DEMO_ENDPOINTS.rustMain) {
    await ensureWorkspacePrepared();
    const payload = await readValidatedJsonBody(
      req,
      res,
      parseRustMainUpdateRequest,
      "Invalid rust-main payload",
    );
    if (!payload) return;
    if (payload.uri !== demoWorkspace.uris.rustMainUri) {
      res.writeHead(400, withCorsHeaders());
      res.end("Invalid rust-main payload");
      return;
    }
    const result = await demoWorkspace.updateRustMainDocument(payload);
    res.writeHead(
      200,
      withCorsHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );
    res.end(JSON.stringify(result));
    return;
  }
  if (req.url.startsWith(`${DEMO_ENDPOINTS.document}?`)) {
    await ensureWorkspacePrepared();
    const url = new URL(req.url, `http://${host}:${port}`);
    const uri = url.searchParams.get("uri");
    if (!uri) {
      res.writeHead(400, withCorsHeaders());
      res.end("Missing uri parameter");
      return;
    }
    try {
      const text = await demoWorkspace.readDocument(uri);
      res.writeHead(
        200,
        withCorsHeaders({
          "Content-Type": "application/json; charset=utf-8",
        }),
      );
      res.end(JSON.stringify({ uri, text }));
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE") {
        res.writeHead(403, withCorsHeaders());
        res.end("URI outside demo workspace");
        return;
      }
      throw error;
    }
    return;
  }
  res.writeHead(
    404,
    withCorsHeaders({
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
  res.end("Not found");
}

const httpServer = createServer((req, res) => {
  void handleHttpRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(
      500,
      withCorsHeaders({
        "Content-Type": "text/plain; charset=utf-8",
      }),
    );
    res.end(message);
  });
});

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", (socket) => {
  const lean = spawn("lake", ["env", "lean", "--server"], {
    cwd: demoWorkspace.paths.workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  pipeServerStderr(lean.stderr);
  attachLspProcess(socket, lean);
});

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
    const { rootPath } = demoWorkspace.rustBlockPaths(block);
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      const rustAnalyzer = spawn("rust-analyzer", [], {
        cwd: rootPath,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pipeServerStderr(rustAnalyzer.stderr);
      attachLspProcess(connection, rustAnalyzer);
    });
    return;
  }
  if (url.pathname === "/rust-main-lsp") {
    wsServer.handleUpgrade(req, socket, head, (connection) => {
      const rustAnalyzer = spawn("rust-analyzer", [], {
        cwd: demoWorkspace.paths.workspaceDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pipeServerStderr(rustAnalyzer.stderr);
      attachLspProcess(connection, rustAnalyzer);
    });
    return;
  }
  socket.destroy();
});

httpServer.listen(port, host, () => {
  console.log(`Lean demo bridge listening on http://${host}:${port}`);
});
