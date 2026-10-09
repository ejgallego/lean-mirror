import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("saves empty text atomically and returns a new revision", async () => {
    const { path, uri, store } = await fixture();
    const original = await store.read(uri);
    const saved = await store.save({ ...original, text: "" });
    expect(saved.revision).not.toBe(original.revision);
    expect(await readFile(path, "utf8")).toBe("");
    expect(await store.read(uri)).toEqual(saved);
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
