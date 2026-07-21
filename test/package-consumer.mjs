import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLeanEditorSession,
  createLeanWorkspace,
  leanFileProgress,
  leanFileProgressMethod,
} from "codemirror-lean4-lsp";

class ConsumerTransport {
  subscribers = new Set();
  sent = [];

  send(encoded) {
    const message = JSON.parse(encoded);
    this.sent.push(message);
    if (message.method === "initialize" && message.id != null) {
      queueMicrotask(() => this.emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 2,
          },
        },
      }));
    }
  }

  subscribe(handler) {
    this.subscribers.add(handler);
  }

  unsubscribe(handler) {
    this.subscribers.delete(handler);
  }

  notifications(method) {
    return this.sent.filter((message) => message.method === method && message.id == null);
  }

  emit(message) {
    const encoded = JSON.stringify(message);
    for (const subscriber of this.subscribers) {
      subscriber(encoded);
    }
  }
}

const URI = "file:///experiment/Main.lean";
const NO_EDITOR_FEATURES = {
  completion: false,
  definitionKeymap: false,
  diagnostics: false,
  formatKeymap: false,
  hover: false,
  referencesKeymap: false,
  renameKeymap: false,
  signatureHelp: false,
};

async function waitFor(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

const progress = leanFileProgress();
const states = [];
let disposedTransports = 0;
const session = createLeanEditorSession({
  client: {
    extensions: [progress],
    features: NO_EDITOR_FEATURES,
    rootUri: "file:///experiment",
    workspace: createLeanWorkspace({
      loadDocument(uri) {
        return uri === URI ? "def answer : Nat := 42\n" : null;
      },
    }),
  },
  onStateChange(state) {
    states.push(`${state.generation}:${state.phase}`);
  },
});

const firstTransport = new ConsumerTransport();
const first = session.connect(firstTransport, {
  disposeTransport() {
    disposedTransports++;
  },
});
await first.initialized;
assert.equal(session.state.phase, "ready");

const workspace = first.client.workspace;
const file = await workspace.openServerDocument(URI);
assert(file, "the public workspace should load a hidden Lean document");
workspace.updateFile(URI, {
  changes: { from: file.doc.length, insert: "#check answer\n" },
});
workspace.updateFile(URI, {
  changes: { from: file.doc.length, insert: "#eval answer\n" },
});
first.client.sync();
await Promise.resolve();

assert.equal(firstTransport.notifications("textDocument/didOpen").length, 1);
assert.equal(firstTransport.notifications("textDocument/didChange").length, 1);

firstTransport.emit({
  jsonrpc: "2.0",
  method: leanFileProgressMethod,
  params: {
    processing: [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    }],
    textDocument: { uri: URI, version: file.version },
  },
});
assert.equal(progress.store.entries().length, 1);

const secondTransport = new ConsumerTransport();
const second = session.reconnect(secondTransport, {
  disposeTransport() {
    disposedTransports++;
  },
});
assert.equal(firstTransport.subscribers.size, 0);
assert.equal(progress.store.entries().length, 0);
assert.notEqual(second.client, first.client);
assert.equal(second.generation, 2);
await second.initialized;

session.dispose();
assert.equal(secondTransport.subscribers.size, 0);
assert.equal(disposedTransports, 2);
assert.deepEqual(session.state, { generation: 2, phase: "disposed" });
assert.deepEqual(states, [
  "1:initializing",
  "1:ready",
  "1:idle",
  "2:initializing",
  "2:ready",
  "2:disposed",
]);

console.log("deterministic public package consumer experiment passed");

class StdioTransport {
  subscribers = new Set();
  buffer = Buffer.alloc(0);
  sent = [];

  constructor(command, args) {
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.process.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    this.closed = new Promise((resolve, reject) => {
      this.process.once("error", reject);
      this.process.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  send(message) {
    this.sent.push(JSON.parse(message));
    const payload = Buffer.from(message, "utf8");
    this.process.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.process.stdin.write(payload);
  }

  subscribe(handler) {
    this.subscribers.add(handler);
  }

  unsubscribe(handler) {
    this.subscribers.delete(handler);
  }

  terminate() {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
  }

  async close() {
    this.terminate();
    return this.closed;
  }

  flush() {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/iu.exec(header);
      assert(match, `missing Content-Length header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      for (const subscriber of this.subscribers) {
        subscriber(body);
      }
    }
  }
}

async function runRealLeanConsumerExperiment() {
  const directory = await mkdtemp(join(tmpdir(), "lean-editor-consumer-"));
  const filePath = join(directory, "Main.lean");
  const source = "def answer : Nat := 42\n#check answer\n";
  await writeFile(filePath, source, "utf8");
  const uri = pathToFileURL(filePath).toString();
  const rootUri = pathToFileURL(directory).toString();
  const transport = new StdioTransport("lean", ["--server"]);
  const diagnostics = [];
  const leanSession = createLeanEditorSession({
    client: {
      features: NO_EDITOR_FEATURES,
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params) => {
          diagnostics.push(params);
          return true;
        },
      },
      rootUri,
      timeout: 15_000,
      workspace: createLeanWorkspace({
        loadDocument(requestedUri) {
          return requestedUri === uri ? source : null;
        },
      }),
    },
  });

  try {
    const connection = leanSession.connect(transport, {
      disposeTransport() {
        transport.terminate();
      },
    });
    await connection.initialized;
    const file = await connection.client.workspace.openServerDocument(uri);
    assert(file, "the real Lean experiment should open its document");
    await Promise.resolve();

    const brokenSource = `${source}#check MissingLeanName\n`;
    connection.client.workspace.updateFile(uri, {
      changes: { from: 0, to: file.doc.length, insert: brokenSource },
    });
    connection.client.sync();
    const brokenVersion = file.version;
    const brokenDiagnostics = await waitFor(
      () => diagnostics.find(
        (params) =>
          params.uri === uri &&
          params.version === brokenVersion &&
          Array.isArray(params.diagnostics) &&
          params.diagnostics.some((diagnostic) => diagnostic.severity === 1),
      ),
      `Lean did not publish diagnostics for broken version ${brokenVersion}`,
    );
    assert(
      brokenDiagnostics.diagnostics.every(
        (diagnostic) =>
          typeof diagnostic.message === "string" && diagnostic.message.length > 0,
      ),
      "Lean diagnostics should contain messages",
    );

    connection.client.workspace.updateFile(uri, {
      changes: { from: 0, to: file.doc.length, insert: source },
    });
    connection.client.sync();
    const recoveredVersion = file.version;
    await waitFor(
      () => diagnostics.find(
        (params) =>
          params.uri === uri &&
          params.version === recoveredVersion &&
          Array.isArray(params.diagnostics) &&
          params.diagnostics.every((diagnostic) => diagnostic.severity !== 1),
      ),
      `Lean did not recover version ${recoveredVersion}: diagnostics=${JSON.stringify(diagnostics)} changes=${JSON.stringify(transport.sent.filter((message) => message.method === "textDocument/didChange"))}`,
    );

    const hover = await connection.client.request("textDocument/hover", {
      position: { line: 0, character: 5 },
      textDocument: { uri },
    });
    assert(hover, "Lean should return hover information for answer");

    leanSession.dispose();
    const exit = await transport.close();
    assert(
      exit.signal === "SIGTERM" || exit.code === 0,
      `lean --server exited unexpectedly (${JSON.stringify(exit)}): ${transport.stderr}`,
    );
  } finally {
    leanSession.dispose();
    await transport.close();
    await rm(directory, { force: true, recursive: true });
  }
}

if (spawnSync("lean", ["--version"], { stdio: "ignore" }).status === 0) {
  await runRealLeanConsumerExperiment();
  console.log("real Lean public package consumer experiment passed");
} else {
  console.log("real Lean public package consumer experiment skipped: lean is not on PATH");
}
