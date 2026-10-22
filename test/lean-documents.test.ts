import { mkdir, mkdtemp, readFile, readdir, rm, symlink, watch, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLeanDocumentStore, parseLeanDocumentSave } from "../demo/server/leanDocuments.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lean-documents-"));
  directories.push(directory);
  const path = join(directory, "Main.lean");
  await writeFile(path, "#check Nat\n");
  return { directory, path, uri: pathToFileURL(path).href, store: createLeanDocumentStore([path]) };
}
describe("Lean document persistence", () => {
  it("preserves an outside edit made during the save, in the destination or recovery archive", async () => {
    const { directory, path, uri, store } = await fixture();
    const recovery = join(directory, ".lean-mirror-recovery");
    await mkdir(recovery);
    const original = await store.read(uri);
    const watcher = watch(recovery, { signal: AbortSignal.timeout(3000) });
    const saving = store.save({ ...original, text: "x".repeat(900_000) }).then(
      (saved) => ({ saved }), (error: unknown) => ({ error }),
    );
    let outsideWrite = false;
    try {
      for await (const event of watcher) {
        if (String(event.filename).endsWith(".tmp")) {
          await writeFile(path, "external edit");
          outsideWrite = true;
          break;
        }
      }
    } finally { await watcher.return?.(); }
    const result = await saving;
    expect(outsideWrite).toBe(true);
    const archive = await readdir(recovery);
    const versions = await Promise.all(archive.filter((name) => name.endsWith(".previous"))
      .map((name) => readFile(join(recovery, name), "utf8")));
    versions.push(await readFile(path, "utf8"));
    expect(versions).toContain("external edit");
    if ("error" in result) expect(result.error).toMatchObject({ code: "ERR_LEAN_DOCUMENT_CONFLICT" });
  });
  it("orders API reads before and after a save without exposing the handoff gap", async () => {
    const { uri, store } = await fixture();
    const original = await store.read(uri);
    const before = Array.from({ length: 20 }, () => store.read(uri));
    const saving = store.save({ ...original, text: "changed" });
    const after = Array.from({ length: 20 }, () => store.read(uri));
    expect((await Promise.all(before)).every((value) => value.text === original.text)).toBe(true);
    await saving;
    expect((await Promise.all(after)).every((value) => value.text === "changed")).toBe(true);
  });
  it("serializes ownership across separate store instances", async () => {
    const { path, uri, store } = await fixture();
    const snapshot = await store.read(uri);
    const other = createLeanDocumentStore([path]);
    const results = await Promise.allSettled([
      store.save({ ...snapshot, text: "first" }), other.save({ ...snapshot, text: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "ERR_LEAN_DOCUMENT_CONFLICT" } },
    ]);
  });
  it("preserves existing permissions under a stricter process umask", async () => {
    const { path, uri } = await fixture();
    const module = pathToFileURL(resolve("demo/server/leanDocuments.mjs")).href;
    const code = `import {chmod,stat} from 'node:fs/promises';
      import {createLeanDocumentStore} from ${JSON.stringify(module)};
      await chmod(${JSON.stringify(path)},0o644); process.umask(0o077);
      const store=createLeanDocumentStore([${JSON.stringify(path)}]);
      const current=await store.read(${JSON.stringify(uri)});
      await store.save({...current,text:'updated'});
      console.log((await stat(${JSON.stringify(path)})).mode & 0o777);`;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }).trim()).toBe(String(0o644));
  });
  it("keeps an interrupted save journal for explicit recovery rather than guessing ownership", async () => {
    const { directory, path, store, uri } = await fixture();
    const snapshot = await store.read(uri);
    const lock = join(directory, ".lean-mirror-recovery", "Main.lean.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "journal.json"), "interrupted transaction");
    await expect(store.save({ ...snapshot, text: "new" })).rejects.toMatchObject({ code: "ERR_LEAN_DOCUMENT_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(snapshot.text);
    expect(await readFile(join(lock, "journal.json"), "utf8")).toBe("interrupted transaction");
  });
  it("saves empty text and retains the displaced disk version", async () => {
    const { path, uri, store } = await fixture();
    const original = await store.read(uri);
    const saved = await store.save({ ...original, text: "" });
    expect(saved.revision).not.toBe(original.revision);
    expect(await readFile(path, "utf8")).toBe("");
    expect(await store.read(uri)).toMatchObject({ uri, text: saved.text, revision: saved.revision });
    expect(await readFile(saved.recoveryPath!, "utf8")).toBe(original.text);
  });
  it("rejects concurrent saves from the same revision without losing the first save", async () => {
    const { path, uri, store } = await fixture();
    const original = await store.read(uri);
    const results = await Promise.allSettled([
      store.save({ ...original, text: "#check Bool\n" }),
      store.save({ ...original, text: "#check String\n" }),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "ERR_LEAN_DOCUMENT_CONFLICT" } });
    expect(await readFile(path, "utf8")).toBe("#check Bool\n");
    const current = await store.read(uri);
    await store.save({ ...current, text: "#check Int\n" });
    expect(await readFile(path, "utf8")).toBe("#check Int\n");
  });
  it("detects edits made outside the host", async () => {
    const { path, uri, store } = await fixture();
    const original = await store.read(uri);
    await writeFile(path, "#check Bool\n");
    await expect(store.save({ ...original, text: "lost update" })).rejects.toMatchObject({ code: "ERR_LEAN_DOCUMENT_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe("#check Bool\n");
  });
  it("rejects unregistered files and symlinks", async () => {
    const { directory, path, store } = await fixture();
    const other = join(directory, "Other.lean");
    await writeFile(other, "private");
    await expect(store.read(pathToFileURL(other).href)).rejects.toMatchObject({ code: "ERR_LEAN_DOCUMENT_FORBIDDEN" });
    const link = join(directory, "Link.lean");
    await symlink(path, link);
    await expect(createLeanDocumentStore([link]).read(pathToFileURL(link).href)).rejects.toMatchObject({ code: "ERR_LEAN_DOCUMENT_FORBIDDEN" });
  });
  it("rejects invalid save payloads", () => {
    expect(() => parseLeanDocumentSave({ uri: "file:///Main.lean", text: "", revision: 0 })).toThrow();
  });
});
