import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function createDemoWorkspace(demoDir, options = {}) {
  const workspaceDir = join(demoDir, "workspace");
  const rustBlocksDir = join(demoDir, "rust-blocks");
  const documentPath = join(workspaceDir, "Main.lean");
  const rustMainPath = join(workspaceDir, "Main.rs");
  const helperPath = join(workspaceDir, "Helper.lean");
  const embeddedLeanPath = join(workspaceDir, "RustSnippets.lean");
  const rootUri = pathToFileURL(workspaceDir).toString();
  const documentUri = pathToFileURL(documentPath).toString();
  const rustMainUri = pathToFileURL(rustMainPath).toString();
  const helperUri = pathToFileURL(helperPath).toString();
  const embeddedLeanUri = pathToFileURL(embeddedLeanPath).toString();
  const documentLanguageIds = {
    [documentUri]: "lean4",
    [embeddedLeanUri]: "lean4",
    [helperUri]: "lean4",
    [rustMainUri]: "rust",
  };
  let preparationStatus = createPreparationStatus("idle", "Waiting to prepare demo workspace.");
  let rustMainUpdateQueue = Promise.resolve();
  const rustBlockUpdateStates = new Map();

  function setPreparationStatus(phase, message, detail) {
    preparationStatus = createPreparationStatus(phase, message, detail);
    options.onStatusChange?.(preparationStatus);
  }

  function rustBlockPaths(key) {
    const slug = slugify(key);
    const rootPath = join(rustBlocksDir, slug);
    const documentPath = join(rootPath, "src", "lib.rs");
    return { documentPath, rootPath, slug };
  }

  async function ensureRustBlockWorkspace(key, code) {
    const { documentPath, rootPath, slug } = rustBlockPaths(key);
    const crateName = "widget";
    await mkdir(join(rootPath, "src"), { recursive: true });
    await writeFile(
      join(rootPath, "Cargo.toml"),
      [
        "[package]",
        `name = "${crateName}"`,
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
        "[dependencies]",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(documentPath, code, "utf8");
    return {
      documentPath,
      documentUri: pathToFileURL(documentPath).toString(),
      rootPath,
      rootUri: pathToFileURL(rootPath).toString(),
      slug,
    };
  }

  async function updateRustBlockDocument(key, code) {
    const { documentPath } = rustBlockPaths(key);
    await writeFile(documentPath, code, "utf8");
  }

  function enqueueRustBlockDocumentUpdate(key, code, version) {
    let state = rustBlockUpdateStates.get(key);
    if (!state) {
      state = { latestVersion: -1, queue: Promise.resolve() };
      rustBlockUpdateStates.set(key, state);
    }
    if (typeof version === "number") {
      state.latestVersion = Math.max(state.latestVersion, version);
    }
    const job = state.queue.then(async () => {
      if (typeof version === "number" && version < state.latestVersion) {
        return false;
      }
      await updateRustBlockDocument(key, code);
      return true;
    });
    state.queue = job.catch(() => {});
    return job;
  }

  async function refreshRustMainArtifacts(payload) {
    await writeFile(rustMainPath, payload.code, "utf8");
    await writeFile(embeddedLeanPath, payload.leanDocument, "utf8");
    return {
      leanDocumentUri: embeddedLeanUri,
      revision: payload.revision,
    };
  }

  function enqueueRustMainUpdate(payload) {
    const job = rustMainUpdateQueue.then(async () => refreshRustMainArtifacts(payload));
    rustMainUpdateQueue = job.catch(() => {});
    return job;
  }

  return {
    paths: {
      workspaceDir,
      rustBlocksDir,
      rustMainPath,
    },
    uris: {
      rootUri,
      documentUri,
      rustMainUri,
      helperUri,
      embeddedLeanUri,
    },
    documentLanguageIds,
    async prepare() {
      try {
        setPreparationStatus("preparing", "Checking demo prerequisites.");
        await ensureDemoPrerequisites();
        setPreparationStatus("preparing", "Preparing embedded Lean document.");
        await ensureEmbeddedLeanArtifacts(embeddedLeanPath);
        setPreparationStatus("preparing", "Checking local demo artifacts.");
        await ensureDemoArtifacts(workspaceDir);
        setPreparationStatus("ready", "Demo workspace ready.");
      } catch (error) {
        setPreparationStatus(
          "failed",
          error instanceof Error ? error.message : "Demo workspace preparation failed.",
        );
        throw error;
      }
    },
    readPreparationStatus() {
      return preparationStatus;
    },
    async readSession({ websocketUrl, rustMainWebsocketUrl }) {
      const initialDoc = await readFile(rustMainPath, "utf8");
      return {
        rootUri,
        documentUri: rustMainUri,
        documentLanguageIds,
        documents: [rustMainUri, embeddedLeanUri, documentUri, helperUri],
        embeddedLeanDocumentUri: embeddedLeanUri,
        initialDoc,
        preparationStatus,
        rustMainDocumentUri: rustMainUri,
        rustMainWebsocketUrl,
        websocketUrl,
      };
    },
    createRustBlockSession: ensureRustBlockWorkspace,
    async readDocument(uri) {
      const path = fileURLToPath(uri);
      if (!path.startsWith(`${workspaceDir}/`) && path !== workspaceDir) {
        const error = new Error("URI outside demo workspace");
        error.code = "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE";
        throw error;
      }
      return readFile(path, "utf8");
    },
    rustBlockPaths,
    updateRustBlockDocument: enqueueRustBlockDocumentUpdate,
    updateRustMainDocument: enqueueRustMainUpdate,
  };
}

function createPreparationStatus(phase, message, detail) {
  return {
    ...(detail ? { detail } : {}),
    message,
    phase,
    updatedAt: new Date().toISOString(),
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ error, status: null, stderr, stdout });
    });
    child.on("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

async function ensureCommandAvailable(command, args, installHint) {
  const result = await runCommand(command, args);
  if (result.status === 0) {
    return;
  }
  const details = result.error?.message ?? result.stderr ?? result.stdout ?? "";
  throw new Error(
    [
      `${command} is required for the demo.`,
      installHint,
      details.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function ensureDemoPrerequisites() {
  await ensureCommandAvailable("lake", ["--version"], "Install Lean through elan and ensure lake is on PATH.");
  await ensureCommandAvailable(
    "rust-analyzer",
    ["--version"],
    "Install it with `rustup component add rust-analyzer` and ensure it is on PATH.",
  );
}

async function ensureDemoArtifacts(workspaceDir) {
  const result = await runCommand("lake", ["build", "Helper"], {
    cwd: workspaceDir,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build demo/workspace with lake build\n${result.stderr ?? result.stdout ?? ""}`.trim(),
    );
  }
}

function defaultEmbeddedLeanDocument() {
  return [
    "/- prelude from Main.rs -/",
    "import Helper",
    "",
    "/- demo-check from Main.rs -/",
    "#check helperValue",
    "#check Nat.succ",
    "",
  ].join("\n");
}

async function readFileOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureEmbeddedLeanArtifacts(embeddedLeanPath) {
  if (!(await readFileOrNull(embeddedLeanPath))) {
    await writeFile(embeddedLeanPath, defaultEmbeddedLeanDocument(), "utf8");
  }
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "embedded-rust";
}
