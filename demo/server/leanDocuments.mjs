import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function revision(text) {
  return createHash("sha256").update(text).digest("hex");
}
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function conflict(detail = "") {
  return failure("ERR_LEAN_DOCUMENT_CONFLICT",
    "File changed on disk or another save owns it. Your edits have been kept. " + detail);
}
export function parseLeanDocumentSave(value) {
  if (!value || typeof value !== "object" ||
      typeof value.uri !== "string" || typeof value.text !== "string" ||
      typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) {
    throw new Error("Expected a document URI, text, and revision.");
  }
  return { uri: value.uri, text: value.text, revision: value.revision };
}

/** Registered local sources only. Archives and journals are never HTTP-writable. */
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
  async function snapshot(uri) {
    const path = await checkedPath(uri);
    const text = await readFile(path, "utf8");
    return { uri, text, revision: revision(text) };
  }
  function enqueue(uri, operation) {
    const previous = queues.get(uri) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    queues.set(uri, task);
    void task.finally(() => {
      if (queues.get(uri) === task) queues.delete(uri);
    }).catch(() => undefined);
    return task;
  }
  function read(uri) {
    // Both earlier and later API reads participate in save ordering.
    return enqueue(uri, () => snapshot(uri));
  }

  async function save({ uri, text, revision: expected }) {
    const path = files.get(uri);
    if (!path) throw failure("ERR_LEAN_DOCUMENT_FORBIDDEN", "Document is not a writable workspace file.");
    const directory = join(dirname(path), ".lean-mirror-recovery");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Recovery path is not a directory.");
    const lock = join(directory, basename(path) + ".lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw conflict("Another writer or an interrupted save owns " + lock + ". Inspect its journal before recovery.");
      throw error;
    }
    const id = randomUUID();
    const backup = join(directory, basename(path) + "." + id + ".previous");
    const temporary = join(directory, basename(path) + "." + id + ".tmp");
    let claimed = false;
    let restored = false;
    try {
      const current = await snapshot(uri);
      if (current.revision !== expected) throw conflict("Copy local edits before reloading.");
      const mode = (await lstat(path)).mode & 0o777;
      const file = await open(temporary, "wx", mode);
      try {
        await file.writeFile(text, "utf8");
        await file.chmod(mode); // Creation mode alone is narrowed by umask.
        await file.sync();
      } finally { await file.close(); }
      // Retain enough information for manual recovery after process interruption.
      await writeFile(join(lock, "journal.json"), JSON.stringify({ path, backup, temporary, pid: process.pid }), { flag: "wx", mode: 0o600 });
      // Claim the actual destination before validation. Unlike hash-then-overwrite,
      // this retains the inode an external writer may already have open.
      await rename(path, backup);
      claimed = true;
      if (!(await lstat(backup)).isFile()) {
        throw failure("ERR_LEAN_DOCUMENT_FORBIDDEN", "Document stopped being a regular file.");
      }
      if (revision(await readFile(backup, "utf8")) !== expected) {
        throw conflict("The concurrent disk version is retained at " + backup + ".");
      }
      // Exclusive publication never overwrites a file recreated by another writer.
      try { await link(temporary, path); }
      catch (error) {
        if (error.code === "EEXIST") throw conflict("The previous disk version is retained at " + backup + ".");
        throw error;
      }
      return { uri, text, revision: revision(text), recoveryPath: backup };
    } catch (error) {
      if (claimed) {
        try { await link(backup, path); restored = true; }
        catch (restoreError) {
          if (restoreError.code === "EEXIST") restored = true; // Keep the outside writer's destination.
          else {
            throw conflict("Recovery is required. The displaced disk version is at " + backup + "; journal: " + lock + ".");
          }
        }
      }
      throw error;
    } finally {
      // Keep the journal and proposed text if the destination could not be restored.
      let destinationPresent = false;
      try { await lstat(path); destinationPresent = true; } catch { /* Preserve recovery state. */ }
      if (!claimed || restored || destinationPresent) {
        await rm(temporary, { force: true });
        await rm(join(lock, "journal.json"), { force: true });
        await rmdir(lock);
      }
    }
  }
  return {
    read,
    save(payload) {
      const parsed = parseLeanDocumentSave(payload);
      return enqueue(parsed.uri, () => save(parsed));
    },
  };
}
