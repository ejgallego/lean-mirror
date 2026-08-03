import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  computeAnnealGenerationInfo,
  findReusableAnnealGeneration,
  hasBuiltLeanArtifacts,
  markAnnealGenerationBuilt,
  registerAnnealGeneration,
} from "../externalGeneration.mjs";
import { parseLineCommentFencedBlocks } from "../shared/embeddedLineComments.mjs";

const zerocopyPr3321Examples = [
  {
    annealArgs: ["--example", "linked_list", "--allow-sorry"],
    id: "linked_list",
    label: "linked_list.rs",
    rustFile: "anneal/examples/linked_list.rs",
    summary: "Method spec over a recursive list model with local helper definitions.",
  },
  {
    annealArgs: ["--example", "namespaces", "--allow-sorry"],
    id: "namespaces",
    label: "namespaces.rs",
    rustFile: "anneal/examples/namespaces.rs",
    summary: "Nested Rust modules that become nested Lean namespaces.",
  },
  {
    annealArgs: ["--example", "size_of_align_of", "--allow-sorry"],
    id: "size_of_align_of",
    label: "size_of_align_of.rs",
    rustFile: "anneal/examples/size_of_align_of.rs",
    summary: "Several Rust doc-comment specs over layout and alignment queries.",
  },
  {
    annealArgs: ["--example", "abs", "--allow-sorry"],
    id: "abs",
    label: "abs.rs",
    rustFile: "anneal/examples/abs.rs",
    summary: "Single-function absolute-value example with a scalar arithmetic proof.",
  },
];

const annealGenerateMaxBuffer = 50 * 1024 * 1024;

export function createDemoWorkspace(demoDir, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const defaultWorkspaceDir = join(demoDir, "workspace");
  const defaultRustBlocksDir = join(demoDir, "rust-blocks");
  const externalRustRoot = env.LEAN_DEMO_RUST_ROOT;
  const initialExternalRustFile = env.LEAN_DEMO_RUST_FILE;
  const externalLeanRoot = env.LEAN_DEMO_LEAN_ROOT;
  const externalAnnealTargetManifest = env.LEAN_DEMO_ANNEAL_MANIFEST;
  const externalAnnealToolManifest =
    env.LEAN_DEMO_ANNEAL_TOOL_MANIFEST ??
    (externalRustRoot ? join(resolvePath(cwd, externalRustRoot), "anneal", "Cargo.toml") : undefined);
  const defaultExternalAnnealArgs = parseEnvArgs(env.LEAN_DEMO_ANNEAL_ARGS);
  const externalExampleSet = env.LEAN_DEMO_EXAMPLE_SET;
  const externalMode = Boolean(
    externalRustRoot || initialExternalRustFile || externalLeanRoot || externalAnnealTargetManifest,
  );
  const skipExternalLeanBuild = env.LEAN_DEMO_SKIP_LEAN_BUILD === "1";
  const externalExamplePresets = resolveExternalExamplePresets({
    defaultExternalAnnealArgs,
    externalExampleSet,
    env,
  });
  let activeExternalExampleId = resolveInitialExternalExampleId({
    externalExamplePresets,
    initialExternalRustFile,
    env,
  });

  let workspaceDir = defaultWorkspaceDir;
  let rustWorkspaceDir = defaultWorkspaceDir;
  let rustSourceRootDir = defaultWorkspaceDir;
  const rustBlocksDir = defaultRustBlocksDir;
  let documentPath = join(defaultWorkspaceDir, "Main.lean");
  let rustMainPath = join(defaultWorkspaceDir, "Main.rs");
  let helperPath = join(defaultWorkspaceDir, "Helper.lean");
  let embeddedLeanPath = join(defaultWorkspaceDir, "RustSnippets.lean");
  let rootUri = "";
  let rustRootUri = "";
  let documentUri = "";
  let rustMainUri = "";
  let helperUri = "";
  let embeddedLeanUri = "";
  let documents = [];
  let documentLanguageIds = {};
  let embeddedLeanDefaultImports = [];
  let embeddedLeanPreamble = [];
  let embeddedLeanPostamble = [];
  let allowedDocumentRoots = [];
  let rustMainUpdateQueue = Promise.resolve();
  let preparationStatus = createPreparationStatus("idle", "Waiting to prepare demo workspace.");
  const rustBlockUpdateStates = new Map();

  function setPreparationStatus(phase, message, detail) {
    preparationStatus = createPreparationStatus(phase, message, detail);
    options.onStatusChange?.(preparationStatus);
  }

  function activeExternalExample() {
    if (!activeExternalExampleId) {
      return null;
    }
    return externalExamplePresets.find((entry) => entry.id === activeExternalExampleId) ?? null;
  }

  function activeExternalRustFile() {
    return activeExternalExample()?.rustFile ?? initialExternalRustFile;
  }

  function activeExternalAnnealArgs() {
    return activeExternalExample()?.annealArgs ?? defaultExternalAnnealArgs;
  }

  function demoDescriptor() {
    if (externalExampleSet === "zerocopy-pr3321") {
      const active = activeExternalExample();
      return {
        activeExampleId: active?.id,
        activeExampleLabel: active?.label ?? "Custom example",
        demoProject: "google/zerocopy PR 3321 / Anneal / Lean 4 / CodeMirror 6",
        demoSummary:
          "This demo opens Rust examples from the zerocopy PR, mirrors `lean, anneal, spec` doc comments into a hidden Lean file, and checks them against the Anneal-generated Lean workspace while rust-analyzer stays attached to the host Rust source.",
        demoTitle: "Zerocopy Anneal Embedded Lean Demo",
      };
    }
    if (externalMode) {
      const active = activeExternalExample();
      return {
        activeExampleId: active?.id,
        activeExampleLabel: active?.label ?? (activeExternalRustFile()?.split("/").at(-1) ?? "External Rust file"),
        demoProject: "External Anneal / Lean 4 / CodeMirror 6",
        demoSummary:
          "This demo mirrors Lean doc-comment snippets embedded in Rust into a hidden Lean file and checks them against an external Anneal-generated Lean workspace.",
        demoTitle: "External Anneal Embedded Lean Demo",
      };
    }
    return {
      activeExampleId: undefined,
      activeExampleLabel: "Default workspace",
      demoProject: "Lean 4 + CodeMirror 6",
      demoSummary:
        "This demo mirrors Lean spec comments embedded in Rust into a hidden Lean file, then checks them through the local Lean LSP while keeping rust-analyzer attached to the host Rust driver.",
      demoTitle: "Embedded Lean over Rust comments",
    };
  }

  function refreshSessionPaths() {
    rootUri = pathToFileURL(workspaceDir).toString();
    rustRootUri = pathToFileURL(rustWorkspaceDir).toString();
    documentUri = pathToFileURL(documentPath).toString();
    rustMainUri = pathToFileURL(rustMainPath).toString();
    helperUri = pathToFileURL(helperPath).toString();
    embeddedLeanUri = pathToFileURL(embeddedLeanPath).toString();

    const documentMap = new Map([
      [rustMainUri, "rust"],
      [embeddedLeanUri, "lean4"],
    ]);
    if (!externalMode) {
      documentMap.set(documentUri, "lean4");
      documentMap.set(helperUri, "lean4");
    }
    documents = [...documentMap.keys()];
    documentLanguageIds = Object.fromEntries(documentMap);
    allowedDocumentRoots = [...new Set([rustSourceRootDir, rustWorkspaceDir, workspaceDir, defaultWorkspaceDir])];
  }

  refreshSessionPaths();

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

  function currentEmbeddedLeanContext() {
    return {
      defaultImports: embeddedLeanDefaultImports,
      externalMode,
      postamble: embeddedLeanPostamble,
      preamble: embeddedLeanPreamble,
      sourceName: basename(rustMainPath),
      sourcePath: rustMainPath,
    };
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

  async function configureExternalWorkspace() {
    if (!externalMode) {
      return;
    }
    const nextRustFile = activeExternalRustFile();
    if (!externalRustRoot || !nextRustFile) {
      throw new Error("External mode requires LEAN_DEMO_RUST_ROOT and LEAN_DEMO_RUST_FILE.");
    }
    const nextRustWorkspaceDir = resolvePath(cwd, externalRustRoot);
    const nextRustMainPath = resolvePath(nextRustWorkspaceDir, nextRustFile);
    const activeLabel = demoDescriptor().activeExampleLabel;
    setPreparationStatus("preparing", `Preparing ${activeLabel}.`);
    const nextRustAnalyzerDir = resolveRustAnalyzerWorkspaceDir({
      cwd,
      externalAnnealTargetManifest,
      fallbackRoot: nextRustWorkspaceDir,
      rustMainPath: nextRustMainPath,
    });
    const externalWorkspace = await resolveExternalLeanWorkspace({
      annealArgs: activeExternalAnnealArgs(),
      cwd,
      env,
      externalAnnealTargetManifest,
      externalAnnealToolManifest,
      externalExamplePresets,
      externalLeanRoot,
      reportStatus: setPreparationStatus,
      rustMainCandidatePath: nextRustMainPath,
      statusLabel: activeLabel,
    });
    const nextLeanWorkspaceDir = externalWorkspace.leanRoot;
    await ensureExternalLeanArtifacts({
      cwd,
      env,
      generationInfo: externalWorkspace.generationInfo,
      generationMetadata: externalWorkspace.metadata,
      leanRoot: nextLeanWorkspaceDir,
      reportStatus: setPreparationStatus,
      skipExternalLeanBuild,
      statusLabel: activeLabel,
    });
    const nextEmbeddedLeanPath = join(nextLeanWorkspaceDir, "user", "EmbeddedSnippets.lean");
    const inferredContext = await inferExternalEmbeddedContext({
      cwd,
      externalAnnealTargetManifest,
      leanRoot: nextLeanWorkspaceDir,
      rustMainPath: nextRustMainPath,
    });

    rustSourceRootDir = nextRustWorkspaceDir;
    rustWorkspaceDir = nextRustAnalyzerDir;
    rustMainPath = nextRustMainPath;
    workspaceDir = nextLeanWorkspaceDir;
    embeddedLeanPath = nextEmbeddedLeanPath;
    documentPath = nextEmbeddedLeanPath;
    helperPath = nextEmbeddedLeanPath;
    embeddedLeanDefaultImports = inferredContext.defaultImports.length > 0
      ? inferredContext.defaultImports
      : ["Anneal", "Generated"];
    embeddedLeanPreamble = inferredContext.preamble.length > 0
      ? inferredContext.preamble
      : [
          "set_option linter.dupNamespace false",
          "set_option linter.unusedVariables false",
          "open Aeneas Aeneas.Std Result",
          "noncomputable section",
          "inject_builtins",
        ];
    embeddedLeanPostamble = inferredContext.postamble;
    refreshSessionPaths();
  }

  async function listAvailableExamples() {
    if (!externalMode || externalExamplePresets.length === 0) {
      return [];
    }
    if (!externalRustRoot || !externalAnnealTargetManifest || !externalAnnealToolManifest) {
      return externalExamplePresets.map((example) => ({
        id: example.id,
        label: example.label,
        ready: false,
        summary: example.summary,
      }));
    }
    const rustRoot = resolvePath(cwd, externalRustRoot);
    const targetManifestPath = resolvePath(cwd, externalAnnealTargetManifest);
    const toolManifestPath = resolvePath(cwd, externalAnnealToolManifest);
    const targetRoot = dirname(targetManifestPath);
    return Promise.all(
      externalExamplePresets.map(async (example) => {
        try {
          const generationInfo = await computeAnnealGenerationInfo({
            annealArgs: example.annealArgs,
            annealToolchainDir: env.ANNEAL_TOOLCHAIN_DIR,
            cargoHome: env.CARGO_HOME,
            rustRelativePath: normalizeSlashes(relative(targetRoot, resolvePath(rustRoot, example.rustFile))),
            rustSourcePath: resolvePath(rustRoot, example.rustFile),
            targetManifestPath,
            toolManifestPath,
            xdgCacheHome: env.XDG_CACHE_HOME,
          });
          const reusable = await findReusableAnnealGeneration(generationInfo);
          return {
            id: example.id,
            label: example.label,
            ready: reusable ? await hasBuiltLeanArtifacts(reusable.leanRoot) : false,
            summary: example.summary,
          };
        } catch {
          return {
            id: example.id,
            label: example.label,
            ready: false,
            summary: example.summary,
          };
        }
      }),
    );
  }

  function canRegenerateExternalWorkspace() {
    return Boolean(
      externalMode &&
        !externalLeanRoot &&
        externalRustRoot &&
        externalAnnealTargetManifest &&
        externalAnnealToolManifest,
    );
  }

  async function readSessionPayload({ websocketUrl, rustMainWebsocketUrl }) {
    const initialDoc = await readFile(rustMainPath, "utf8");
    const descriptor = demoDescriptor();
    return {
      activeExampleId: descriptor.activeExampleId,
      availableExamples: await listAvailableExamples(),
      canRegenerate: canRegenerateExternalWorkspace(),
      demoProject: descriptor.demoProject,
      demoSummary: descriptor.demoSummary,
      demoTitle: descriptor.demoTitle,
      preparationStatus,
      rootUri,
      documentUri: rustMainUri,
      documentLanguageIds,
      documents,
      embeddedLeanDefaultImports,
      embeddedLeanDocumentUri: embeddedLeanUri,
      embeddedLeanPostamble,
      embeddedLeanPreamble,
      initialDoc,
      rustRootUri,
      rustMainDocumentUri: rustMainUri,
      rustMainWebsocketUrl,
      websocketUrl,
    };
  }

  function regenerateRustMainDocument(payload, urls) {
    if (!canRegenerateExternalWorkspace()) {
      throw new Error("Regeneration is only available for manifest-backed external Anneal demos.");
    }
    if (payload.uri !== rustMainUri) {
      throw new Error("Rust document changed; refresh the demo before regenerating.");
    }
    const job = rustMainUpdateQueue.then(async () => {
      try {
        setPreparationStatus("preparing", "Saving Rust source before regeneration.");
        await writeFile(rustMainPath, payload.code, "utf8");
        await configureExternalWorkspace();
        await ensureEmbeddedLeanArtifacts(embeddedLeanPath, currentEmbeddedLeanContext());
        setPreparationStatus("ready", "Demo workspace ready.");
        return readSessionPayload(urls);
      } catch (error) {
        setPreparationStatus(
          "failed",
          error instanceof Error ? error.message : "Anneal workspace regeneration failed.",
        );
        throw error;
      }
    });
    rustMainUpdateQueue = job.catch(() => {});
    return job;
  }

  return {
    paths: {
      get workspaceDir() {
        return workspaceDir;
      },
      get rustWorkspaceDir() {
        return rustWorkspaceDir;
      },
      get rustBlocksDir() {
        return rustBlocksDir;
      },
      get rustMainPath() {
        return rustMainPath;
      },
    },
    uris: {
      get rootUri() {
        return rootUri;
      },
      get documentUri() {
        return documentUri;
      },
      get rustMainUri() {
        return rustMainUri;
      },
      get helperUri() {
        return helperUri;
      },
      get embeddedLeanUri() {
        return embeddedLeanUri;
      },
    },
    get documentLanguageIds() {
      return documentLanguageIds;
    },
    async prepare() {
      try {
        setPreparationStatus("preparing", "Checking demo prerequisites.");
        await ensureDemoPrerequisites();
        await configureExternalWorkspace();
        setPreparationStatus("preparing", "Preparing embedded Lean document.");
        await ensureEmbeddedLeanArtifacts(embeddedLeanPath, currentEmbeddedLeanContext());
        setPreparationStatus("preparing", "Checking local demo artifacts.");
        await ensureDemoArtifacts(workspaceDir, { externalMode });
        setPreparationStatus("ready", "Demo workspace ready.");
      } catch (error) {
        setPreparationStatus(
          "failed",
          error instanceof Error ? error.message : "Demo workspace preparation failed.",
        );
        throw error;
      }
    },
    readSession: readSessionPayload,
    readPreparationStatus() {
      return preparationStatus;
    },
    createRustBlockSession: ensureRustBlockWorkspace,
    async readDocument(uri) {
      const path = fileURLToPath(uri);
      if (!allowedDocumentRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
        const error = new Error("URI outside demo workspace");
        error.code = "ERR_DEMO_DOCUMENT_OUTSIDE_WORKSPACE";
        throw error;
      }
      return readFile(path, "utf8");
    },
    rustBlockPaths,
    async switchExample(exampleId) {
      if (!externalMode || externalExamplePresets.length === 0) {
        throw new Error("No switchable external examples are configured.");
      }
      const nextExample = externalExamplePresets.find((entry) => entry.id === exampleId);
      if (!nextExample) {
        throw new Error(`Unknown example: ${exampleId}`);
      }
      const previousExampleId = activeExternalExampleId;
      const failedExampleLabel = nextExample.label;
      activeExternalExampleId = exampleId;
      try {
        await configureExternalWorkspace();
        await ensureEmbeddedLeanArtifacts(embeddedLeanPath, currentEmbeddedLeanContext());
        setPreparationStatus("ready", `${demoDescriptor().activeExampleLabel} ready.`);
      } catch (error) {
        activeExternalExampleId = previousExampleId;
        try {
          await configureExternalWorkspace();
          await ensureEmbeddedLeanArtifacts(embeddedLeanPath, currentEmbeddedLeanContext());
        } catch {
          // Preserve the original switch error; the next explicit prepare/switch will report fresh status.
        }
        setPreparationStatus(
          "failed",
          error instanceof Error
            ? `Failed to prepare ${failedExampleLabel}: ${error.message}`
            : `Failed to prepare ${failedExampleLabel}.`,
        );
        throw error;
      }
    },
    regenerateRustMainDocument,
    updateRustBlockDocument: enqueueRustBlockDocumentUpdate,
    updateRustMainDocument: enqueueRustMainUpdate,
  };
}

function resolvePath(base, value) {
  return isAbsolute(value) ? value : resolve(base, value);
}

function createPreparationStatus(phase, message, detail) {
  return {
    ...(detail ? { detail } : {}),
    message,
    phase,
    updatedAt: new Date().toISOString(),
  };
}

function isPathInside(path, root) {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveRustAnalyzerWorkspaceDir({ cwd, externalAnnealTargetManifest, fallbackRoot, rustMainPath }) {
  if (!externalAnnealTargetManifest) {
    return fallbackRoot;
  }
  const manifestRoot = dirname(resolvePath(cwd, externalAnnealTargetManifest));
  return isPathInside(rustMainPath, manifestRoot) ? manifestRoot : fallbackRoot;
}

function resolveExternalExamplePresets({ defaultExternalAnnealArgs, externalExampleSet, env }) {
  if (env.LEAN_DEMO_EXAMPLE_PRESETS) {
    const parsed = JSON.parse(env.LEAN_DEMO_EXAMPLE_PRESETS);
    if (!Array.isArray(parsed)) {
      throw new Error("LEAN_DEMO_EXAMPLE_PRESETS must be a JSON array.");
    }
    return parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}] must be an object.`);
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].id must be a non-empty string.`);
      }
      if (typeof entry.rustFile !== "string" || entry.rustFile.length === 0) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].rustFile must be a non-empty string.`);
      }
      if (
        entry.annealArgs !== undefined &&
        (!Array.isArray(entry.annealArgs) || entry.annealArgs.some((item) => typeof item !== "string"))
      ) {
        throw new Error(`LEAN_DEMO_EXAMPLE_PRESETS[${index}].annealArgs must be a string array.`);
      }
      return {
        annealArgs: entry.annealArgs ?? defaultExternalAnnealArgs,
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        rustFile: entry.rustFile,
        summary: typeof entry.summary === "string" ? entry.summary : "",
      };
    });
  }
  if (externalExampleSet === "zerocopy-pr3321") {
    return zerocopyPr3321Examples;
  }
  return [];
}

function resolveInitialExternalExampleId({ env, externalExamplePresets, initialExternalRustFile }) {
  if (externalExamplePresets.length === 0) {
    return null;
  }
  const explicit = env.LEAN_DEMO_ACTIVE_EXAMPLE;
  if (explicit && externalExamplePresets.some((entry) => entry.id === explicit)) {
    return explicit;
  }
  const matchingRustFile = externalExamplePresets.find((entry) => entry.rustFile === initialExternalRustFile);
  return matchingRustFile?.id ?? externalExamplePresets[0]?.id ?? null;
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

async function ensureDemoArtifacts(workspaceDir, { externalMode }) {
  if (externalMode) {
    return;
  }
  const result = await runCommand("lake", ["build", "Helper"], {
    cwd: workspaceDir,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build demo/workspace with lake build\n${result.stderr ?? result.stdout ?? ""}`.trim(),
    );
  }
}

function defaultEmbeddedLeanDocument({ defaultImports = [], externalMode = false, postamble = [], preamble = [] } = {}) {
  if (externalMode) {
    const imports = defaultImports.map((moduleName) => `import ${moduleName}`);
    return [
      ...imports,
      imports.length > 0 ? "" : null,
      ...preamble,
      preamble.length > 0 ? "" : null,
      ...postamble,
      "",
    ].filter((line) => line !== null).join("\n");
  }
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

function embeddedLeanRole(info) {
  const normalized = info.toLowerCase();
  return normalized === "editor-prelude" ||
    normalized === "prelude" ||
    normalized.startsWith("editor-prelude,") ||
    normalized.startsWith("editor-prelude ") ||
    normalized.startsWith("prelude,") ||
    normalized.startsWith("prelude ") ||
    normalized.includes(" editor-prelude") ||
    normalized.includes(" prelude")
    ? "prelude"
    : "snippet";
}

function embeddedLeanTitle(info, ordinal) {
  const normalized = info.replaceAll(",", " ").trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : `block ${ordinal}`;
}

function parseEmbeddedLeanBlocks(source) {
  return parseLineCommentFencedBlocks(source, {
    kind: "lean",
    linePrefixes: ["//!", "///", "//"],
  }).map((block) => ({
    code: block.code,
    role: embeddedLeanRole(block.info ?? ""),
    sourceLine: block.sourceLine,
    title: embeddedLeanTitle(block.info ?? "", block.ordinal),
  }));
}

function buildEmbeddedLeanDocumentFromSource(source, options = {}) {
  const blocks = parseEmbeddedLeanBlocks(source);
  const prelude = blocks.filter((block) => block.role === "prelude");
  const snippets = blocks.filter((block) => block.role !== "prelude");
  const lines = [];
  for (const moduleName of options.defaultImports ?? []) {
    lines.push(`import ${moduleName}`);
  }
  if (options.defaultImports?.length > 0) {
    lines.push("");
  }
  if (options.preamble?.length > 0) {
    lines.push(...options.preamble);
    lines.push("");
  }
  for (const block of [...prelude, ...snippets]) {
    lines.push(`/- ${block.title} from ${options.sourceName ?? "Rust source"}:${block.sourceLine} -/`);
    lines.push(...block.code.split("\n"));
    lines.push("");
  }
  if (options.postamble?.length > 0) {
    lines.push(...options.postamble);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
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

async function ensureEmbeddedLeanArtifacts(embeddedLeanPath, context) {
  await mkdir(dirname(embeddedLeanPath), { recursive: true });
  const nextDocument = context.sourcePath
    ? buildEmbeddedLeanDocumentFromSource(await readFile(context.sourcePath, "utf8"), context)
    : defaultEmbeddedLeanDocument(context);
  if (await readFileOrNull(embeddedLeanPath) !== nextDocument) {
    await writeFile(embeddedLeanPath, nextDocument, "utf8");
  }
}

function parseEnvArgs(value) {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("LEAN_DEMO_ANNEAL_ARGS JSON must be a string array.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

function parseGeneratedLeanRoot(output) {
  const match = /Lean workspace generated at:\s*(.+)\s*$/m.exec(output);
  return match?.[1]?.trim() ?? null;
}

function runCargoMetadata({ env, manifestPath }) {
  const result = spawnSync(
    "cargo",
    ["metadata", "--manifest-path", manifestPath, "--format-version=1", "--no-deps"],
    {
      cwd: dirname(manifestPath),
      encoding: "utf8",
      env,
      maxBuffer: annealGenerateMaxBuffer,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Failed to inspect Anneal tool metadata\n${output}`.trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse Anneal tool metadata: ${message}\n${output}`.trim());
  }
}

function resolveAnnealToolBinary({ cwd, env, toolManifest }) {
  const metadata = runCargoMetadata({ env, manifestPath: toolManifest });
  const packageMetadata =
    metadata.packages?.find((pkg) => resolvePath(cwd, pkg.manifest_path) === toolManifest) ??
    metadata.packages?.find((pkg) => pkg.name === "cargo-anneal") ??
    metadata.packages?.[0];
  const binTarget =
    packageMetadata?.targets?.find((target) => target.name === "cargo-anneal" && target.kind?.includes("bin")) ??
    packageMetadata?.targets?.find((target) => target.kind?.includes("bin"));
  if (!metadata.target_directory || !binTarget) {
    throw new Error("Anneal tool manifest does not expose a binary target.");
  }
  const extension = process.platform === "win32" ? ".exe" : "";
  return {
    binName: binTarget.name,
    path: join(metadata.target_directory, "debug", `${binTarget.name}${extension}`),
  };
}

function buildAnnealTool({ cwd, env, toolManifest }) {
  const binary = resolveAnnealToolBinary({ cwd, env, toolManifest });
  const result = spawnSync("cargo", ["build", "--manifest-path", toolManifest, "--bin", binary.binName], {
    cwd: dirname(toolManifest),
    encoding: "utf8",
    env,
    maxBuffer: annealGenerateMaxBuffer,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Failed to build Anneal generator tool\n${output}`.trim());
  }
  return binary.path;
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function isIgnorableGeneratedLine(trimmed) {
  return trimmed.length === 0 || trimmed.startsWith("--");
}

function isGeneratedSnippetStart(trimmed) {
  return trimmed.startsWith("@[") || /^(?:theorem|lemma|def|example|axiom|opaque|abbrev|instance|inductive|structure|class|mutual)\b/u.test(trimmed);
}

function trimFunctionNamespaceForMultiSnippetContext(lines, preamble, postamble) {
  const snippetCount = lines.filter((line) => isGeneratedSnippetStart(line.trim())).length;
  if (snippetCount <= 1) {
    return { postamble, preamble };
  }

  const nextPreamble = [...preamble];
  const nextPostamble = [...postamble];
  const functionNamespace = nextPreamble.findLastIndex((line) => /^namespace\s+\S+/u.test(line));
  if (functionNamespace >= 0) {
    nextPreamble.splice(functionNamespace, 1);
  }
  if (nextPostamble[0] && /^end(?:\s+.+)?$/u.test(nextPostamble[0])) {
    nextPostamble.shift();
  }
  return {
    postamble: nextPostamble,
    preamble: nextPreamble,
  };
}

function extractGeneratedLeanContext(text) {
  const lines = text.split(/\r?\n/u);
  const defaultImports = [];
  const preamble = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (isIgnorableGeneratedLine(trimmed)) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("import ")) {
      defaultImports.push(trimmed.slice("import ".length));
      index += 1;
      continue;
    }
    break;
  }

  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (isIgnorableGeneratedLine(trimmed)) {
      index += 1;
      continue;
    }
    if (isGeneratedSnippetStart(trimmed)) {
      break;
    }
    preamble.push(trimmed);
    index += 1;
  }

  const postamble = [];
  let tail = lines.length - 1;
  while (tail >= index) {
    const trimmed = lines[tail]?.trim() ?? "";
    if (isIgnorableGeneratedLine(trimmed)) {
      tail -= 1;
      continue;
    }
    if (/^end(?:\s+.+)?$/u.test(trimmed)) {
      postamble.unshift(trimmed);
      tail -= 1;
      continue;
    }
    break;
  }

  const context = trimFunctionNamespaceForMultiSnippetContext(lines, preamble, postamble);
  return {
    defaultImports,
    postamble: context.postamble,
    preamble: context.preamble,
  };
}

async function inferExternalEmbeddedContext({ cwd, externalAnnealTargetManifest, leanRoot, rustMainPath }) {
  const generatedDir = join(leanRoot, "generated");
  let sourceRelative = null;
  if (externalAnnealTargetManifest) {
    const targetRoot = dirname(resolvePath(cwd, externalAnnealTargetManifest));
    sourceRelative = normalizeSlashes(relative(targetRoot, rustMainPath));
  }

  const candidates = [];
  for (const entry of await readdir(generatedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const moduleName = entry.name;
    const funsPath = join(generatedDir, moduleName, "Funs.lean");
    const specPath = join(generatedDir, moduleName, `${moduleName}.lean`);
    const [funsText, specText] = await Promise.all([readFileOrNull(funsPath), readFileOrNull(specPath)]);
    if (!funsText || !specText) {
      continue;
    }
    if (sourceRelative && !funsText.includes(`Source: '${sourceRelative}'`)) {
      continue;
    }
    candidates.push(extractGeneratedLeanContext(specText));
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  return {
    defaultImports: [],
    postamble: [],
    preamble: [],
  };
}

function runAnnealGenerate({
  annealArgs,
  cwd,
  env,
  externalAnnealTargetManifest,
  externalAnnealToolManifest,
  externalLeanRoot,
  generationInfo,
  reportStatus,
  statusLabel,
}) {
  if (externalLeanRoot) {
    return resolvePath(cwd, externalLeanRoot);
  }
  if (!externalAnnealToolManifest || !externalAnnealTargetManifest) {
    throw new Error(
      "External mode requires LEAN_DEMO_LEAN_ROOT or LEAN_DEMO_ANNEAL_TOOL_MANIFEST plus LEAN_DEMO_ANNEAL_MANIFEST.",
    );
  }

  const toolManifest = resolvePath(cwd, externalAnnealToolManifest);
  const targetManifest = resolvePath(cwd, externalAnnealTargetManifest);
  const targetRoot = dirname(targetManifest);
  reportStatus?.("preparing", `Building Anneal generator for ${statusLabel ?? "external example"}.`);
  const annealBinary = buildAnnealTool({ cwd, env, toolManifest });
  const args = [
    "generate",
    "--manifest-path",
    targetManifest,
    ...annealArgs,
  ];
  reportStatus?.("preparing", `Generating Lean workspace for ${statusLabel ?? "external example"}.`);
  const result = spawnSync(annealBinary, args, {
    cwd: targetRoot,
    encoding: "utf8",
    env: {
      ...env,
      // Anneal uses this as the run-root directory name; key it per example so switchable demos do not overwrite each other.
      ANNEAL_TEST_DIR_NAME: generationInfo.key,
    },
    maxBuffer: annealGenerateMaxBuffer,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Failed to generate Anneal Lean workspace\n${output}`.trim());
  }
  const expectedLeanRoot = join(targetRoot, "target", "anneal", generationInfo.key, "lean");
  const leanRoot = parseGeneratedLeanRoot(output) ?? (existsSync(expectedLeanRoot) ? expectedLeanRoot : null);
  if (!leanRoot) {
    throw new Error(`Anneal generation did not report a Lean workspace path.\n${output}`.trim());
  }
  return leanRoot;
}

async function resolveExternalLeanWorkspace({
  annealArgs,
  cwd,
  env,
  externalAnnealTargetManifest,
  externalAnnealToolManifest,
  externalExamplePresets,
  externalLeanRoot,
  reportStatus,
  rustMainCandidatePath,
  statusLabel,
}) {
  if (externalLeanRoot) {
    if (externalExamplePresets.length > 0) {
      throw new Error("Example switching requires manifest-based external mode, not a fixed LEAN_DEMO_LEAN_ROOT.");
    }
    return {
      generationInfo: null,
      metadata: null,
      leanRoot: resolvePath(cwd, externalLeanRoot),
    };
  }
  if (!externalAnnealToolManifest || !externalAnnealTargetManifest) {
    throw new Error(
      "External mode requires LEAN_DEMO_LEAN_ROOT or LEAN_DEMO_ANNEAL_TOOL_MANIFEST plus LEAN_DEMO_ANNEAL_MANIFEST.",
    );
  }
  const targetManifest = resolvePath(cwd, externalAnnealTargetManifest);
  const toolManifest = resolvePath(cwd, externalAnnealToolManifest);
  const targetRoot = dirname(targetManifest);
  reportStatus?.("preparing", `Checking generated workspace cache for ${statusLabel ?? "external example"}.`);
  const generationInfo = await computeAnnealGenerationInfo({
    annealArgs,
    annealToolchainDir: env.ANNEAL_TOOLCHAIN_DIR,
    cargoHome: env.CARGO_HOME,
    rustRelativePath: normalizeSlashes(relative(targetRoot, rustMainCandidatePath)),
    rustSourcePath: rustMainCandidatePath,
    targetManifestPath: targetManifest,
    toolManifestPath: toolManifest,
    xdgCacheHome: env.XDG_CACHE_HOME,
  });
  const reusable = await findReusableAnnealGeneration(generationInfo);
  if (reusable) {
    reportStatus?.("preparing", `Reusing generated Lean workspace for ${statusLabel ?? "external example"}.`);
    return {
      generationInfo,
      metadata: reusable,
      leanRoot: reusable.leanRoot,
    };
  }
  const leanRoot = runAnnealGenerate({
    annealArgs,
    cwd,
    env,
    externalAnnealTargetManifest,
    externalAnnealToolManifest,
    externalLeanRoot,
    generationInfo,
    reportStatus,
    statusLabel,
  });
  const metadata = await registerAnnealGeneration(generationInfo, leanRoot);
  return {
    generationInfo,
    metadata,
    leanRoot,
  };
}

async function ensureExternalLeanArtifacts({
  cwd,
  env,
  generationInfo,
  generationMetadata,
  leanRoot,
  reportStatus,
  skipExternalLeanBuild,
  statusLabel,
}) {
  if (skipExternalLeanBuild) {
    reportStatus?.("preparing", `Skipping Lean build for ${statusLabel ?? "external example"}.`);
    return generationMetadata;
  }
  reportStatus?.("preparing", `Checking Lean artifacts for ${statusLabel ?? "external example"}.`);
  await repairExternalLakeManifest({ cwd, env, leanRoot });
  if (!generationInfo && await hasBuiltLeanArtifacts(leanRoot)) {
    reportStatus?.("preparing", `Reusing built Lean artifacts for ${statusLabel ?? "external example"}.`);
    return generationMetadata;
  }
  if (generationMetadata?.buildCompletedAt && await hasBuiltLeanArtifacts(leanRoot)) {
    reportStatus?.("preparing", `Reusing built Lean artifacts for ${statusLabel ?? "external example"}.`);
    return generationMetadata;
  }

  reportStatus?.("preparing", `Fetching Lean dependency cache for ${statusLabel ?? "external example"}.`);
  const cacheResult = spawnSync("lake", ["exe", "cache", "get"], {
    cwd: leanRoot,
    env,
    stdio: "inherit",
  });
  if (cacheResult.status !== 0) {
    throw new Error("Failed to populate Lean dependency cache with `lake exe cache get`.");
  }

  reportStatus?.("preparing", `Building generated Lean workspace for ${statusLabel ?? "external example"}.`);
  const buildResult = spawnSync("lake", ["build"], {
    cwd: leanRoot,
    env,
    stdio: "inherit",
  });
  if (buildResult.status !== 0) {
    throw new Error("Failed to build generated Lean workspace with lake build.");
  }
  if (!generationInfo) {
    reportStatus?.("preparing", `Lean artifacts ready for ${statusLabel ?? "external example"}.`);
    return generationMetadata;
  }
  const metadata = await markAnnealGenerationBuilt(generationInfo, leanRoot);
  reportStatus?.("preparing", `Lean artifacts ready for ${statusLabel ?? "external example"}.`);
  return metadata;
}

async function repairExternalLakeManifest({ cwd, env, leanRoot }) {
  const annealToolchainDir = env.ANNEAL_TOOLCHAIN_DIR;
  if (!annealToolchainDir) {
    return;
  }
  const manifestPath = join(leanRoot, "lake-manifest.json");
  const manifest = await readFileOrNull(manifestPath);
  const toolchainUrlPattern = String.raw`file:\/\/\/(?:[^"\\]|\\.)*anneal-toolchain`;
  if (!manifest || !new RegExp(toolchainUrlPattern).test(manifest)) {
    return;
  }
  const toolchainUrl = pathToFileURL(resolvePath(cwd, annealToolchainDir)).href;
  await writeFile(
    manifestPath,
    manifest.replace(new RegExp(toolchainUrlPattern, "g"), toolchainUrl),
    "utf8",
  );
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "embedded-rust";
}
