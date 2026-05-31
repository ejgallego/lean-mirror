import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readDemoConfig } from "./demo-config.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const defaultCheckoutDir = join(rootDir, ".demo-cache", "zerocopy-pr3321");
const defaultRepoUrl = "https://github.com/google/zerocopy.git";
const defaultPrRef = "pull/3321/head";
const defaultExamples = ["linked_list", "namespaces", "size_of_align_of", "abs"];
const linkedListOldReturnSpec = [
  "    ///   Aeneas.Std.WP.spec (List.push self val) (fun ret_ =>",
  "    ///     let (_, self') := ret_",
  "    ///     self'.len = self.len + 1) := by",
  "    ///   unfold List.push",
  "    ///   simp_all",
  "    ///   rw [\u2190 h_returns]",
  "    ///   simp_all",
  "    ///   omega",
].join("\n");
const linkedListCurrentReturnSpec = [
  "    ///   Aeneas.Std.WP.spec (List.push self val) (fun self' =>",
  "    ///     self'.len = self.len + 1) := by",
  "    ///   unfold List.push",
  "    ///   simp_all",
  "    ///   omega",
].join("\n");
const namespacesOldSpec = [
  "        /// theorem spec (x : Std.U32) (h_req : x.val + 1 ≤ 4294967295) :",
  "        ///   Aeneas.Std.WP.spec (outer.inner.deep_function x) (fun ret_ => ret_.val = x.val + 1) := by",
  "        ///   unfold deep_function",
  "        ///   have h := Aeneas.Std.U32.add_bv_spec (x := x) (y := 1#u32) (by scalar_tac)",
  "        ///   simp_all",
].join("\n");
const namespacesCurrentSpec = [
  "        /// theorem spec (x : Std.U32) (h_req : x.val + 1 ≤ 4294967295) :",
  "        ///   Aeneas.Std.WP.spec (outer.inner.deep_function x) (fun ret_ => ret_.val = x.val + 1) := by",
  "        ///   unfold deep_function",
  "        ///   have h := Aeneas.Std.U32.add_spec (x := x) (y := 1#u32) (by scalar_tac)",
  "        ///   exact h",
].join("\n");
const sizeOfAlignFirstOldSpec = [
  "/// theorem spec :",
  "///   Aeneas.Std.WP.spec (get_size_of_empty_tuple) (fun ret_ => ret_.val = 0) := by",
].join("\n");
const sizeOfAlignFirstCurrentSpec = [
  "/// theorem get_size_of_empty_tuple_spec :",
  "///   Aeneas.Std.WP.spec (get_size_of_empty_tuple) (fun ret_ => ret_.val = 0) := by",
].join("\n");
const sizeOfAlignSecondOldSpec = [
  "/// theorem spec :",
  "///   Aeneas.Std.WP.spec (get_align_of_empty_tuple) (fun ret_ => ret_.val = 1) := by",
].join("\n");
const sizeOfAlignSecondCurrentSpec = [
  "/// theorem get_align_of_empty_tuple_spec :",
  "///   Aeneas.Std.WP.spec (get_align_of_empty_tuple) (fun ret_ => ret_.val = 1) := by",
].join("\n");
const sizeOfAlignSillyOldSpec = [
  "/// theorem spec {T : Type} (_val : ConstRawPtr T)",
  "///   (h_req : ∃ (_sz : Anneal.core.marker.Sized T) (tl : Anneal.HasStaticLayout T), True) :",
  "///   Aeneas.Std.WP.spec (silly_size_of _val) (fun ret_ =>",
  "///     match core.mem.size_of T with",
  "///     | Result.ok size => ret_.val = size.val",
  "///     | _ => False) := by",
  "///   rcases h_req with ⟨_sz, tl, _⟩",
  "///   unfold silly_size_of",
  "///   have h_align_pos : 0 < (Anneal.HasStaticLayout.layout T).align.val.val := (Anneal.HasStaticLayout.layout T).align.isValid.left",
  "///   have h_align_nz : (Anneal.HasStaticLayout.layout T).align.val.val ≠ 0 := by omega",
  "///   simp_all",
  "///   step",
  "///   step",
  "///   · rw [i_post]",
  "///     simp",
  "///   · rw [i_post] at r_post",
  "///     simp at r_post",
  "///     exact r_post",
].join("\n");
const sizeOfAlignSillyCurrentSpec = [
  "/// theorem silly_size_of_spec {T : Type} (_val : ConstRawPtr T)",
  "///   (h_req : ∃ (_sz : Anneal.core.marker.Sized T) (tl : Anneal.HasStaticLayout T), True) :",
  "///   Aeneas.Std.WP.spec (silly_size_of _val) (fun ret_ =>",
  "///     match core.mem.size_of T with",
  "///     | Result.ok size => ret_.val = size.val",
  "///     | _ => False) := by",
  "///   eval_allow_sorry_or_fail \"silly_size_of demo proof is not stable across current Anneal output.\"",
].join("\n");

function usage() {
  return [
    "Usage: npm run demo:zerocopy-anneal -- [options]",
    "",
    "Options:",
    "  --root <path>      Use an existing zerocopy checkout instead of cloning PR 3321.",
    "  --repo <url>       Git repository to clone when --root is not set.",
    "  --ref <ref>        Git ref to fetch when --root is not set.",
    "  --checkout-dir <path>",
    "                     Persistent checkout path when --root is not set.",
    "  --active <id>      Startup example id. Defaults to linked_list.",
    "  --no-warm         Start the demo without prebuilding every prepared example.",
    "  --no-install      Do not run npm install when node_modules is missing.",
    "  --keep            Accepted for compatibility; local checkouts are always kept.",
    "  --help            Show this help.",
    "",
    "Environment overrides:",
    "  ZEROCOPY_ROOT or LEAN_DEMO_ZEROCOPY_ROOT can replace --root.",
    "  LEAN_DEMO_ZEROCOPY_REPO and LEAN_DEMO_ZEROCOPY_REF can replace --repo/--ref.",
    "  LEAN_DEMO_ZEROCOPY_CHECKOUT_DIR can replace --checkout-dir.",
    "  LEAN_DEMO_KEEP_ZEROCOPY_CHECKOUT=1 is accepted for compatibility.",
    "  LEAN_DEMO_SKIP_NPM_INSTALL=1 is equivalent to --no-install.",
    "  LEAN_DEMO_WARM_EXAMPLES=0 is equivalent to --no-warm.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    active: process.env.LEAN_DEMO_ACTIVE_EXAMPLE ?? defaultExamples[0],
    checkoutDir: process.env.LEAN_DEMO_ZEROCOPY_CHECKOUT_DIR,
    install: process.env.LEAN_DEMO_SKIP_NPM_INSTALL !== "1",
    ref: process.env.LEAN_DEMO_ZEROCOPY_REF ?? defaultPrRef,
    repo: process.env.LEAN_DEMO_ZEROCOPY_REPO ?? defaultRepoUrl,
    root: process.env.LEAN_DEMO_ZEROCOPY_ROOT ?? process.env.ZEROCOPY_ROOT,
    warm: process.env.LEAN_DEMO_WARM_EXAMPLES !== "0",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--no-install") {
      options.install = false;
      continue;
    }
    if (arg === "--no-warm") {
      options.warm = false;
      continue;
    }
    if (arg === "--warm") {
      options.warm = true;
      continue;
    }
    if (["--active", "--checkout-dir", "--ref", "--repo", "--root"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function ensureCommandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    const details = result.error?.message ? ` (${result.error.message})` : "";
    throw new Error(`${command} is required for the zerocopy Anneal demo${details}.`);
  }
}

function run(command, args, options = {}) {
  console.log(`[demo:zerocopy] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

function commandSucceeds(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: "ignore",
  });
  return result.status === 0;
}

async function ensureNpmDependencies(install) {
  if (await pathExists(join(rootDir, "node_modules", "vite", "package.json"))) {
    return;
  }
  if (!install) {
    throw new Error("node_modules is missing. Run npm install, or omit --no-install.");
  }
  ensureCommandAvailable("npm", ["--version"]);
  run("npm", ["install"]);
}

async function cloneZerocopy(options) {
  ensureCommandAvailable("git", ["--version"]);
  const checkout = resolve(options.checkoutDir ?? defaultCheckoutDir);
  const gitDir = join(checkout, ".git");
  if (await pathExists(gitDir)) {
    console.log(`[demo:zerocopy] Updating cached checkout ${checkout}`);
  } else {
    console.log(`[demo:zerocopy] Creating cached checkout ${checkout}`);
    await mkdir(checkout, { recursive: true });
    run("git", ["init", checkout]);
  }
  if (commandSucceeds("git", ["remote", "get-url", "origin"], { cwd: checkout })) {
    run("git", ["remote", "set-url", "origin", options.repo], { cwd: checkout });
  } else {
    run("git", ["remote", "add", "origin", options.repo], { cwd: checkout });
  }
  try {
    run("git", ["fetch", "--depth=1", "origin", options.ref], { cwd: checkout });
    run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: checkout });
    return checkout;
  } catch (error) {
    throw error;
  }
}

async function ensureZerocopyCheckout(root) {
  const required = [
    join(root, "Cargo.toml"),
    join(root, "anneal", "Cargo.toml"),
    join(root, "anneal", "examples", "linked_list.rs"),
  ];
  const missing = [];
  for (const path of required) {
    if (!(await pathExists(path))) {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    throw new Error(`The zerocopy checkout is missing required files:\n${missing.join("\n")}`);
  }
}

function applyManagedPatch(source, path, label, oldText, newText) {
  if (source.includes(newText)) {
    return { patched: false, source };
  }
  if (!source.includes(oldText)) {
    console.warn(`[demo:zerocopy] ${path} did not match the expected ${label} patch; leaving it unchanged.`);
    return { patched: false, source };
  }
  return { patched: true, source: source.replace(oldText, newText) };
}

async function patchManagedExample(path, patches) {
  let source = await readFile(path, "utf8");
  let patched = false;
  for (const patch of patches) {
    const result = applyManagedPatch(source, path, patch.label, patch.oldText, patch.newText);
    source = result.source;
    patched = patched || result.patched;
  }
  if (patched) {
    await writeFile(path, source, "utf8");
    console.log(`[demo:zerocopy] Patched ${path}.`);
  }
}

async function patchManagedZerocopyCheckout(root) {
  await patchManagedExample(join(root, "anneal", "examples", "linked_list.rs"), [
    {
      label: "current generated Lean return shape",
      oldText: linkedListOldReturnSpec,
      newText: linkedListCurrentReturnSpec,
    },
  ]);
  await patchManagedExample(join(root, "anneal", "examples", "namespaces.rs"), [
    {
      label: "current U32 addition proof",
      oldText: namespacesOldSpec,
      newText: namespacesCurrentSpec,
    },
  ]);
  await patchManagedExample(join(root, "anneal", "examples", "size_of_align_of.rs"), [
    {
      label: "size_of_empty_tuple theorem name",
      oldText: sizeOfAlignFirstOldSpec,
      newText: sizeOfAlignFirstCurrentSpec,
    },
    {
      label: "align_of_empty_tuple theorem name",
      oldText: sizeOfAlignSecondOldSpec,
      newText: sizeOfAlignSecondCurrentSpec,
    },
    {
      label: "current silly_size_of proof",
      oldText: sizeOfAlignSillyOldSpec,
      newText: sizeOfAlignSillyCurrentSpec,
    },
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSession(apiBase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/session`);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`Session request failed with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  const message = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for demo backend at ${apiBase}.${message}`);
}

async function switchExample(apiBase, id) {
  const response = await fetch(`${apiBase}/switch-example`, {
    body: JSON.stringify({ id }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Switching to ${id} failed with ${response.status}`);
  }
}

async function warmExamples(apiBase, activeExample, timeoutMs) {
  const session = await fetchSession(apiBase, timeoutMs);
  const examples = Array.isArray(session.availableExamples) && session.availableExamples.length > 0
    ? session.availableExamples.map((example) => example.id)
    : defaultExamples;
  const initialExample = session.activeExampleId ?? activeExample ?? examples[0];
  let failures = 0;

  console.log(`[demo:zerocopy] Warming prepared examples: ${examples.join(", ")}`);
  for (const id of examples) {
    if (id === initialExample) {
      continue;
    }
    try {
      console.log(`[demo:zerocopy] Preparing ${id}`);
      await switchExample(apiBase, id);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[demo:zerocopy] Failed to prepare ${id}: ${message}`);
    }
  }

  if (initialExample && examples.includes(initialExample)) {
    try {
      await switchExample(apiBase, initialExample);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[demo:zerocopy] Failed to restore ${initialExample}: ${message}`);
    }
  }

  if (failures > 0) {
    console.error(`[demo:zerocopy] ${failures} example preparation step(s) failed; the demo remains running.`);
    return;
  }
  console.log("[demo:zerocopy] All prepared examples are built and ready. Refresh the browser if it is already open.");
}

function signalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  ensureCommandAvailable("cargo", ["--version"]);
  ensureCommandAvailable("lake", ["--version"]);
  ensureCommandAvailable("rust-analyzer", ["--version"]);
  await ensureNpmDependencies(options.install);

  const checkoutRoot = options.root ? resolve(options.root) : await cloneZerocopy(options);
  await ensureZerocopyCheckout(checkoutRoot);
  if (!options.root) {
    await patchManagedZerocopyCheckout(checkoutRoot);
  }

  const env = {
    ...process.env,
    DEMO_BACKEND_READY_TIMEOUT_MS: process.env.DEMO_BACKEND_READY_TIMEOUT_MS ?? "600000",
    DEMO_WATCH_USE_POLLING: process.env.DEMO_WATCH_USE_POLLING ?? "1",
    LEAN_DEMO_ACTIVE_EXAMPLE: options.active,
    LEAN_DEMO_ANNEAL_MANIFEST: join(checkoutRoot, "anneal", "Cargo.toml"),
    LEAN_DEMO_EXAMPLE_SET: "zerocopy-pr3321",
    LEAN_DEMO_RUST_ROOT: checkoutRoot,
  };
  const demo = readDemoConfig(env);
  const warmTimeoutMs = Number.parseInt(env.DEMO_BACKEND_READY_TIMEOUT_MS, 10);
  const backendReadyTimeoutMs = Number.isFinite(warmTimeoutMs) && warmTimeoutMs > 0
    ? warmTimeoutMs
    : 600000;

  console.log(`[demo:zerocopy] Using zerocopy checkout: ${checkoutRoot}`);
  console.log(`[demo:zerocopy] Frontend: ${demo.frontendUrl}`);
  console.log(`[demo:zerocopy] Backend: ${demo.backendUrl}`);

  const child = spawn(process.execPath, ["./scripts/run-demo.mjs"], {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  let forwardedSignal = null;
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  const childExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (options.warm) {
    void warmExamples(demo.backendUrl, options.active, backendReadyTimeoutMs).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[demo:zerocopy] Example warmup failed: ${message}`);
    });
  } else {
    console.log("[demo:zerocopy] Skipping prepared example warmup.");
  }

  const exit = await childExit;
  return exit.code ?? signalExitCode(exit.signal ?? forwardedSignal);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
