import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createLeanDocumentStore } from "../demo/server/leanDocuments.mjs";
import { handleLeanDocumentRequest } from "../demo/server/leanDocumentHttp.mjs";

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("serves snapshots and preserves save HTTP status contracts over real sockets", async () => {
  directory = await mkdtemp(join(tmpdir(), "lean-http-"));
  const path = join(directory, "Main.lean");
  await writeFile(path, "#check Nat\n");
  const uri = pathToFileURL(path).href;
  const store = createLeanDocumentStore([path]);
  server = createServer((req, res) => {
    void handleLeanDocumentRequest(req, res, { store, maxBodyBytes: 256 }).catch(() => {
      res.writeHead(500); res.end("failed");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const base = `http://127.0.0.1:${address.port}/lean-document`;
  const url = base + "?uri=" + encodeURIComponent(uri);
  const initial = await fetch(url);
  expect(initial.status).toBe(200);
  const snapshot = await initial.json();
  const saved = await fetch(base, { method: "POST", body: JSON.stringify({ ...snapshot, text: "#check Bool\n" }) });
  expect(saved.status).toBe(200);
  expect((await saved.json()).recoveryPath).toContain(".lean-mirror-recovery");
  const conflict = await fetch(base, { method: "POST", body: JSON.stringify(snapshot) });
  expect(conflict.status).toBe(409);
  await conflict.text();
  expect(await readFile(path, "utf8")).toBe("#check Bool\n");
  for (const body of ["{", "{}"]) {
    const response = await fetch(base, { method: "POST", body });
    expect(response.status).toBe(400); await response.text();
  }
  const oversized = await fetch(base, { method: "POST", body: "x".repeat(1024) });
  expect(oversized.status).toBe(413); await oversized.text();
  const forbidden = await fetch(base + "?uri=" + encodeURIComponent("file:///private.lean"));
  expect(forbidden.status).toBe(403); await forbidden.text();
  const missing = await fetch(base);
  expect(missing.status).toBe(400); await missing.text();
  const method = await fetch(url, { method: "DELETE" });
  expect(method.status).toBe(405); await method.text();
});
