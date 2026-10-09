import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function revision(text) {
  return createHash("sha256").update(text).digest("hex");
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseLeanDocumentSave(value) {
  if (!value || typeof value !== "object" ||
      typeof value.uri !== "string" || typeof value.text !== "string" ||
      typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) {
    throw new Error("Expected a document URI, text, and revision.");
  }
  return { uri: value.uri, text: value.text, revision: value.revision };
}

/** Explicitly writable development files; generated and external files stay outside this store. */
export function createLeanDocumentStore(paths) {
  const files = new Map(paths.map((path) => {
    const absolute = resolve(path);
    return [pathToFileURL(absolute).href, absolute];
  }));
  const queues = new Map();

  async function checkedPath(uri) {
    const path = files.get(uri);
    if (!path || !(await lstat(path)).isFile()) {
      throw failure("ERR_LEAN_DOCUMENT_FORBIDDEN", "Document is not a writable workspace file.");
    }
    return path;
  }

  async function read(uri) {
    const path = await checkedPath(uri);
    const text = await readFile(path, "utf8");
    return { uri, text, revision: revision(text) };
  }

  return {
    read,
    save(payload) {
      const { uri, text, revision: expected } = parseLeanDocumentSave(payload);
      const previous = queues.get(uri) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(async () => {
        const current = await read(uri);
        if (current.revision !== expected) {
          throw failure("ERR_LEAN_DOCUMENT_CONFLICT", "File changed on disk. Your edits have been kept. Copy them before reloading the page.");
        }
        const path = await checkedPath(uri);
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
          await writeFile(temporary, text, { flag: "wx", mode: (await lstat(path)).mode });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        return { uri, text, revision: revision(text) };
      });
      queues.set(uri, task);
      void task.finally(() => {
        if (queues.get(uri) === task) queues.delete(uri);
      }).catch(() => undefined);
      return task;
    },
  };
}
