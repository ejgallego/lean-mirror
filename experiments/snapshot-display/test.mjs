// Native protocol integration test for the experiment, using the real file worker.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const root = fileURLToPath(new URL(".", import.meta.url));
const plugin = resolve(
  root,
  ".lake/build/lib",
  process.platform === "darwin"
    ? "libsnapshotDisplay_DisplayProbe.dylib"
    : "libsnapshotDisplay_DisplayProbe.so",
);
const uri = pathToFileURL(resolve(root, "Fixture.lean")).href;
let source = await readFile(resolve(root, "Fixture.lean"), "utf8"),
  version = 1;
assert.notEqual(
  process.platform,
  "win32",
  "This native process-group harness requires POSIX",
);
const proc = spawn(
  "lake",
  ["env", "lean", "--server", `--plugin=${plugin}`, "-DstderrAsMessages=false"],
  { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "",
  buffer = Buffer.alloc(0),
  nextId = 0;
const pending = new Map();
proc.stdin.on("error", rejectAll);
proc.stderr.on("data", (b) => {
  stderr = (stderr + b).slice(-16384);
});
function rejectAll(error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}
const closed = new Promise((resolve) => {
  proc.once("error", resolve);
  proc.once("close", resolve);
});
function signalGroup(signal) {
  if (proc.pid === undefined) return false;
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
proc.on("error", rejectAll);
proc.on("exit", (code) =>
  rejectAll(new Error(`server exited ${code}: ${stderr}`)),
);
proc.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) break;
    const length = Number(
      /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
    );
    if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) {
      rejectAll(new Error("invalid frame"));
      signalGroup("SIGTERM");
      return;
    }
    if (buffer.length < end + 4 + length) break;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (msg.method) {
      if (msg.id !== undefined)
        send({
          id: msg.id,
          error: { code: -32601, message: "Unsupported client method" },
        });
      continue;
    }
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error
        ? p.reject(Object.assign(new Error(msg.error.message), msg.error))
        : p.resolve(msg.result);
    }
  }
});
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function request(method, params, timeoutMs = 15000) {
  if (
    proc.exitCode !== null ||
    proc.signalCode !== null ||
    proc.stdin.destroyed
  )
    return Promise.reject(new Error(`server is not running: ${stderr}`));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}; ${stderr}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
const probe = (extra = {}) =>
  request("$/leanMirror/displayProbe", {
    textDocument: { uri, version },
    source,
    waitMs: 1000,
    policy: "all",
    names: [],
    ...extra,
  });
function change(text) {
  source = text;
  version++;
  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri, version }, contentChanges: [{ text }] },
  });
}
async function complete() {
  for (let i = 0; i < 15; i++) {
    const r = await probe();
    if (r.snapshotStatus === "complete") return r;
  }
  throw new Error("worker did not complete");
}
function validateRanges(r) {
  assert.equal(r.version, version);
  assert.equal(r.positionEncoding, "utf16");
  assert.equal(r.rangeBase, "file");
  for (const c of r.commands) {
    assert(c.range.start <= c.range.stop && c.range.stop <= source.length);
    for (const n of c.regions)
      assert.equal(source.slice(n.range.start, n.range.stop), n.text);
  }
}
const evidence = {};
try {
  await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
    initializationOptions: { hasWidgets: false },
  });
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, version, languageId: "lean4", text: source },
    },
  });
  const full = await complete();
  validateRanges(full);
  evidence.initial = full;
  assert(
    full.commands.some((c) =>
      c.regions.some((r) => r.kind === "Lean.Parser.Command.theorem"),
    ),
  );
  assert(
    full.commands.some((c) =>
      c.regions.some((r) => r.kind === "Lean.Parser.Command.docComment"),
    ),
  );
  const theorems = await probe({ policy: "theorems" });
  assert(theorems.commands.some((c) => !c.selected));
  assert(theorems.commands.some((c) => c.selected));
  const names = await probe({ policy: "names", names: ["identity_eq"] });
  const chosen = names.commands.filter((c) => c.selected);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].namespaceName, "DisplayFixture");
  assert(
    chosen[0].regions.some(
      (r) =>
        r.kind === "Lean.Parser.Command.declSig" &&
        r.text === ": identity x = x",
    ),
  );
  assert(
    chosen[0].regions.some(
      (r) =>
        r.kind === "Lean.Parser.Command.declValSimple" &&
        r.text === ":= by\n  rfl",
    ),
  );
  assert(
    chosen[0].regions.some((r) => r.kind === "Lean.Parser.Command.docComment"),
  );
  evidence.selection = names;
  const mutual = await probe({ policy: "names", names: ["even"] });
  const selectedMutual = mutual.commands.filter((c) => c.selected);
  assert.equal(selectedMutual.length, 1);
  assert(
    selectedMutual[0].regions.some(
      (r) => r.kind === "Lean.Parser.Command.declId" && r.text === "odd",
    ),
  );
  const again = await probe();
  assert(again.commands.every((c) => c.selected));
  await assert.rejects(probe({ waitMs: 1001 }), (e) => e.code === -32602);
  await assert.rejects(probe({ policy: "unknown" }), (e) => e.code === -32602);
  await assert.rejects(
    probe({ textDocument: { uri, version: version - 1 } }),
    (e) => e.code === -32801,
  );
  await assert.rejects(
    probe({ source: source + " " }),
    (e) => e.code === -32801,
  );
  change("-- inserted 😀\r\n" + source.replaceAll("\n", "\r\n"));
  const crlf = await complete();
  validateRanges(crlf);
  evidence.crlf = crlf;
  change(source + "\r\ntheorem unfinished : True := by\r\n");
  const broken = await complete();
  validateRanges(broken);
  evidence.incomplete = broken;
  assert.equal(broken.semanticStatus, "not-assessed");
  const beforeSlow = source;
  change(beforeSlow + "\n#eval IO.sleep 2000\n");
  const partial = await probe({ waitMs: 0 });
  assert.equal(partial.snapshotStatus, "partial");
  evidence.partial = partial;
  const eventual = await complete();
  assert.equal(eventual.version, partial.version);
  change(beforeSlow + "\n#eval IO.sleep 3000\n");
  assert.equal((await probe({ waitMs: 0 })).snapshotStatus, "partial");
  const cancelled = probe();
  const cancellationCheck = assert.rejects(cancelled, (e) => e.code === -32800);
  send({ method: "$/cancelRequest", params: { id: nextId } });
  await cancellationCheck;
  const superseded = probe();
  const supersededCheck = assert.rejects(superseded, (e) => e.code === -32801);
  change(beforeSlow);
  await supersededCheck;
  validateRanges(await complete());
  await writeFile(
    resolve(root, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
} finally {
  try {
    await request("shutdown", {}, 5000);
  } catch {}
  if (!proc.stdin.destroyed) {
    send({ method: "exit" });
    proc.stdin.end();
  }
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    signalGroup("SIGKILL");
  }, 5000);
  await closed;
  clearTimeout(timer);
  rejectAll(new Error("test finished"));
  // A successful parent exit alone is not evidence that its worker exited.
  for (let i = 0; i < 20 && signalGroup(0); i++) await delay(100);
  const leaked = signalGroup("SIGKILL");
  assert(
    !forced && !leaked,
    `owned processes survived shutdown: forced=${forced}, remainingGroup=${leaked}, pid=${proc.pid}; ${stderr}`,
  );
}
console.log(
  "PASS: actual worker structure, documentation, policies, version/source rejection, CRLF/non-BMP ranges, incomplete proof, partial-to-complete same revision, cancellation, edit invalidation, process cleanup",
);
