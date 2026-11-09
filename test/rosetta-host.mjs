import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { forwardLspFrames, writeLspFrame } from "../demo/server/lspProcessBridge.mjs";

async function until(action, accepts, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Rosetta result did not become ready");
}

test("Rosetta serves all six editor features and versioned Cargo diagnostics", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lean-mirror-rosetta-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "Cargo.toml"), '[package]\nname="rosetta_editor_test"\nversion="0.1.0"\nedition="2021"\n[workspace]\n');
  const path = join(root, "src", "lib.rs");
  const uri = pathToFileURL(path).href;
  const text = '// 𝒜\r\npub fn add(a: i32, b: i32) -> i32 { a + b }\r\npub fn demo() -> i32 { /* 𝒜 */ add(20, 22) }\r\n';
  await writeFile(path, text);
  const child = spawn(process.env.LEAN_DEMO_ROSETTA_BINARY, [root], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-10000); });
  let nextId = 0;
  const pending = new Map();
  const notifications = [];
  forwardLspFrames(child.stdout, raw => {
    const message = JSON.parse(raw);
    if (message.id === undefined) { notifications.push(message); return; }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(new Error(`${request.method}: ${message.error.message}`), {
      code: message.error.code,
    }));
    else request.resolve(message.result);
  });
  const notify = (method, params) => writeLspFrame(child.stdin, { jsonrpc: "2.0", method, params });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 25000);
    pending.set(id, { resolve, reject, timer, method });
    writeLspFrame(child.stdin, { jsonrpc: "2.0", id, method, params });
  });
  const change = async (text, version) => {
    await writeFile(path, text);
    notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    notify("textDocument/didSave", { textDocument: { uri }, text });
  };
  try {
    const initialized = await request("initialize", {});
    assert.equal(initialized.serverInfo.name, "Rosetta / rust-analyzer");
    notify("initialized", {});
    notify("textDocument/didOpen", { textDocument: { uri, languageId: "rust", text, version: 7 } });
    const base = { textDocument: { uri } };
    const position = { line: 2, character: text.split("\n")[2].indexOf("add") + 1 };
    const hover = await until(() => request("textDocument/hover", { ...base, position }), value => value !== null);
    assert.match(JSON.stringify(hover), /add/);
    const tokens = await until(() => request("rosetta/preview", base),
      value => value.some(token => token.tokenType === "function"));
    assert.ok(tokens.some(token => token.tokenType === "function"));
    const definition = await until(() => request("textDocument/definition", { ...base, position }), value => value.length > 0);
    assert.equal(definition[0].targetUri ?? definition[0].uri, uri);
    const rename = await request("textDocument/rename", { ...base, position, newName: "sum" });
    assert.equal(rename.changes[uri].length, 2);
    assert.match(JSON.stringify(rename), /"newText":"sum"/);
    const formatting = await request("textDocument/formatting", { ...base, options: { tabSize: 4, insertSpaces: true } });
    assert.ok(formatting.length > 0);
    const partial = text.replace("add(20", "ad(20");
    await change(partial, 8);
    const completion = await request("textDocument/completion", { ...base,
      position: { line: 2, character: partial.split("\n")[2].indexOf("ad(20") + 2 } });
    assert.ok((completion.items ?? completion).some(item => item.label.startsWith("add")));
    await change(text.replace("a + b", "MissingRustName"), 9);
    await until(() => Promise.resolve(notifications.find(message => message.method === "textDocument/publishDiagnostics" &&
      message.params.version === 9 && message.params.diagnostics.some(diagnostic => diagnostic.code === "E0425"))), Boolean);
    await change(text, 10);
    await until(() => Promise.resolve(notifications.find(message => message.method === "textDocument/publishDiagnostics" &&
      message.params.version === 10 && message.params.diagnostics.length === 0)), Boolean);
    await request("shutdown", null);
    notify("exit", null);
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await rm(root, { recursive: true, force: true });
  }
});
