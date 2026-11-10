# Demo guide

See the [README quickstart](../README.md#run-the-demos) for prerequisites and the
two main demo entry points.

### Minimal experiment host

The smallest browser integration needs only `lean` and `lake` on `PATH`:

```bash
npm run example:minimal
```

Open `http://127.0.0.1:5273`. This repository example displays one Lean
document and combines the public `LeanEditorSession`, `LeanWorkspace`, and
optional infoview entries with the currently private editor-platform shell
prototype. Its reconnect button preserves the CodeMirror document while
replacing the Lean client generation.

The example separates a
[copyable public-only editor composition](https://github.com/ejgallego/lean-mirror/blob/main/examples/minimal/publicLeanEditor.ts)
from that private shell. `npm run test:packed:browser` copies the same
composition into an isolated app, installs the generated tarball, production
bundles it without repository aliases, and runs the real-Lean browser scenario.

See the
[minimal example guide](https://github.com/ejgallego/lean-mirror/blob/main/examples/minimal/README.md)
for its repository-only infrastructure, scope, and port overrides.

### Multi-file workspace host

```bash
npm run example:workspace
```

Open `http://127.0.0.1:5274` to switch between `Main.lean` and `Helper.lean`,
follow definitions with F12, and save both files to disk. Each file keeps its
editor state and undo history when Lean reconnects after a dropped connection.
Revision-checked saves report conflicts while keeping local edits and retain
previous disk versions for recovery. See the [save/recovery contract](workspace-persistence.md)
for outside-writer and interruption limits.
See the [workspace example guide](../examples/workspace/README.md) for the public-only
composition and browser checks.

### Full integration demo

The demo expects `lean`, `lake`, and `rust-analyzer` on `PATH`. The repository and
demo workspace pin Lean 4.35.0; an elan installation selects and installs that
toolchain automatically. `rust-analyzer` can be installed with
`rustup component add rust-analyzer rust-src rustfmt`. External Anneal mode also needs
`cargo` and a checkout of the Rust project whose examples you want to open.

If the Lean WebSocket closes, the demo starts a fresh client/server generation
without remounting the active CodeMirror editor. A complete runtime restart is
retained as the fallback when generation recovery itself fails.

Install the npm dependencies if needed, then start the in-repo sample workspace:

```bash
npm install
npm run demo
```

Open `http://127.0.0.1:5173`. The default opens `AeneasDemo.lean`, a static
mock-up of a Rust `bump(&mut u32)` function paired with its Lean translation.
The raw Verso docstring attaches directly to the Lean `bump` definition; a checked
theorem and success/overflow evaluations follow it. The translation is adapted
by hand using a small local model of checked arithmetic, rather than generated
by Aeneas. Rust edits leave the Lean definition and proof unchanged.

The Lean editor shows the raw Verso docstring, including its prose and Rust fences. The Rust source is editable,
with Rosetta-backed hovers mapped into the comment. **Render Rust** in the gutter
opens the retained preview with semantic colors, hovers, and diagnostics;
**Edit Rust** reveals the full inline editor with completion, definition, rename,
and formatting. **Preview Rust** returns to the preview; **Show Verso source**
in the gutter returns to the raw document. All three presentations use the same
Lean buffer and preserve its prose. `?view=rendered` starts with the preview.
`?example=basic` opens the earlier `Main.lean` example instead.
File switching preserves text, selection, and undo history; Rust and Lean can
reconnect without discarding editor state.

The Rust-driver experiment remains available at
`http://127.0.0.1:5173/?mode=rust`, or through the `Main.rs` document button.
The external Anneal wrapper still opens its Rust source by default.

Rosetta is currently unpublished. This demo includes a pinned Apache-2.0 core
snapshot and builds its native host under `.demo-cache/rosetta-host`. The root
project, demo workspace, and bundled Rosetta all use Lean 4.35.0, selected by elan. Override `LEAN_DEMO_ROSETTA_ROOT` to use a
local Rosetta core checkout. For ongoing development, select it once with
`npm run demo:rosetta:checkout -- /path/to/packages/rosetta`; the demo watches
its Lean sources and rebuilds after edits. The ignored local selection takes
precedence over the bundled CI fallback. See [the Rosetta host guide](../demo/rosetta/README.md).
The first launch can take longer while the host toolchain is installed.

The all-in-one script starts:

- a Vite frontend in `demo/`
- a small WebSocket bridge that proxies browser JSON-RPC frames to `lake env lean --server`
- a Rosetta host that owns rust-analyzer sessions for embedded Rust
- a direct rust-analyzer bridge for the separate Rust-driver mode
- a multi-file editor demo that can switch between the default Lean files, the Rust source, and the synthesized Lean snippet document
- a pure Rust-driver path where edits to `Main.rs` refresh `RustSnippets.lean` without importing generated Aeneas output

If those ports are busy, override them:

```bash
DEMO_BACKEND_PORT=7358 DEMO_FRONTEND_PORT=5174 npm run demo
```

The backend binds to loopback by default and then rejects requests whose `Host` header is not a
loopback name, which blocks DNS-rebinding pages. Directly binding it to a non-loopback address is refused
unless `LEAN_DEMO_ALLOW_REMOTE=1` is set; that mode skips the `Host` check. Remote mode is intended only for controlled experiments;
configure `LEAN_DEMO_ALLOWED_ORIGINS`, payload limits, and the LSP process cap before using it.

External generation can take several minutes. When `LEAN_DEMO_ANNEAL_MANIFEST`
or `LEAN_DEMO_LEAN_ROOT` is set, `npm run demo` waits up to 5 minutes for the
backend by default; override that with `DEMO_BACKEND_READY_TIMEOUT_MS`.

### Zerocopy Anneal examples

For the PR-specific demo, use the setup wrapper:

```bash
npm run demo:zerocopy-anneal
```

That script:

- creates or updates a persistent checkout of `google/zerocopy` PR 3321 under `.demo-cache/`
- runs `npm install` first if `node_modules` is missing
- starts the normal `npm run demo` stack with the required `LEAN_DEMO_*` variables
- prebuilds every built-in prepared example through the demo backend

Useful options:

```bash
npm run demo:zerocopy-anneal -- --root /path/to/zerocopy-pr3321
npm run demo:zerocopy-anneal -- --checkout-dir /path/to/local/zerocopy-pr3321
npm run demo:zerocopy-anneal -- --active namespaces
npm run demo:zerocopy-anneal -- --no-warm
```

Run only the external-demo browser checks with a managed demo process:

```bash
npm run test:e2e:zerocopy-anneal
npm run test:e2e:zerocopy-anneal -- --root /path/to/zerocopy-pr3321
```

The test command waits for every prepared example before starting Playwright
and stops the demo stack afterward. Pass `--no-warm` for the shorter active-example
smoke path; checks that require another prepared example will then be skipped.
Set `DEMO_EXTERNAL_E2E_READY_TIMEOUT_MS` to change the default 30-minute setup timeout.

Use `--root` to reuse an existing checkout without letting the wrapper update it.
Use `--checkout-dir` to choose where the wrapper creates and updates its
persistent local checkout. The same port overrides still apply:

```bash
DEMO_BACKEND_PORT=7358 DEMO_FRONTEND_PORT=5174 npm run demo:zerocopy-anneal
```

By default the Anneal tool manifest is read from
`$LEAN_DEMO_RUST_ROOT/anneal/Cargo.toml`. If your Anneal tool checkout lives
somewhere else, export this before running the wrapper:

```bash
LEAN_DEMO_ANNEAL_TOOL_MANIFEST=/path/to/anneal/Cargo.toml
```

If the generated Lean workspace's `lake-manifest.json` contains an Anneal
toolchain placeholder URL, also set
`ANNEAL_TOOLCHAIN_DIR=/path/to/toolchain` so the demo can rewrite that manifest
entry before running `lake build`.

The Zerocopy wrapper supplies these prepared examples to the generic demo backend:

- `linked_list`
- `namespaces`
- `size_of_align_of`
- `abs`

The wrapper prepares all of them by default. Without the wrapper, startup
generates and builds only the active example; prepared example buttons are
enabled after their generated Lean workspace has been cached and built. To make
all built-in examples available in manual external mode, start the external demo
once, wait for `Demo backend listening on http://127.0.0.1:7357`, and run this
from a second terminal:

```bash
for example in linked_list namespaces size_of_align_of abs; do
  curl -fsS \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$example\"}" \
    http://127.0.0.1:7357/switch-example
done
```

Each request may run Anneal generation plus `lake exe cache get` and
`lake build`. Refresh the browser after the loop; all successfully built
examples should be clickable in the Prepared Examples panel. If you changed
`DEMO_BACKEND_PORT`, use that port in the `curl` URL.

Useful external-mode variables:

- `LEAN_DEMO_RUST_ROOT`: root of the Rust checkout used by rust-analyzer
- `LEAN_DEMO_RUST_FILE`: one Rust file to open when not using an example set
- `LEAN_DEMO_ANNEAL_MANIFEST`: `Cargo.toml` for the Rust project Anneal should generate from
- `LEAN_DEMO_ANNEAL_TOOL_MANIFEST`: `Cargo.toml` for the Anneal generator tool
- `LEAN_DEMO_ANNEAL_ARGS`: extra generator args, either shell-style text or a JSON string array
- `LEAN_DEMO_LEAN_ROOT`: use an already generated Lean workspace instead of invoking Anneal; this disables example switching
- `LEAN_DEMO_ACTIVE_EXAMPLE`: choose the startup preset, for example `namespaces`
- `LEAN_DEMO_EXAMPLE_PRESETS`: JSON array of custom presets with `id`, `label`, `rustFile`, optional `summary`, and optional `annealArgs`
- `LEAN_DEMO_TITLE`, `LEAN_DEMO_PROJECT`, and `LEAN_DEMO_SUMMARY`: customize the external demo descriptor
- `LEAN_DEMO_SKIP_LEAN_BUILD=1`: skip `lake exe cache get` and `lake build` for an external Lean workspace
- `DEMO_WATCH_USE_POLLING=0`: opt out of the default polling Vite watcher and use native filesystem watches
- `PLAYWRIGHT_BROWSERS_PATH`: browser cache for E2E tests; defaults to `.demo-cache/playwright-browsers`
