# CodeMirror Lean 4 LSP

Lean 4 language support for CodeMirror 6, built around the official `@codemirror/lsp-client`.

The top-level package export is intentionally Lean-focused. If you want raw `@codemirror/lsp-client` building blocks, use the explicit `codemirror-lean4-lsp/codemirror` subpath.

This package stays intentionally thin:

- Lightweight fallback Lean syntax tokenization via `leanFallbackLanguageSupport()`
- Explicit client-generation lifecycle via `createLeanEditorSession()`
- Session-aware CodeMirror rebinding via `leanEditorSessionBinding()`
- Lean-aware `LSPClient` factory via `createLeanLspClient()`
- Opt-in Lean semantic-token rendering via `features.semanticTokens` or `leanSemanticTokens()`
- Typed Lean `$/lean/fileProgress` tracking via `leanFileProgress()`
- Optional multi-file host workspace via `createLeanWorkspace()`
- LocationLink-aware cross-file navigation and atomic workspace edits
- Optional official Lean infoview bridge via the `/infoview` subpath
- Standard editor utilities via `leanUtilities()`
- Browser transport helpers for `WebSocket` and `MessagePort`
- A small `lean4(...)` helper that composes language support with a direct or session-managed LSP plugin

## Install

```bash
npm install codemirror-lean4-lsp
```

## Usage

```ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession,
  createWebSocketTransport,
  lean4,
  leanFallbackHighlightStyle,
  waitForWebSocketOpen,
} from "codemirror-lean4-lsp";

const socket = new WebSocket("ws://localhost:8080");
const session = createLeanEditorSession({
  client: {
    features: {
      semanticTokens: true,
    },
    rootUri: "file:///workspace",
  },
});

await waitForWebSocketOpen(socket);
const { initialized } = session.connect(createWebSocketTransport(socket), {
  disposeTransport() {
    socket.close();
  },
});
await initialized;

const state = EditorState.create({
  doc: "#check Nat.succ\n",
  extensions: lean4({
    session,
    highlightStyle: leanFallbackHighlightStyle,
    uri: "file:///workspace/Main.lean",
  }),
});

new EditorView({
  state,
  parent: document.querySelector("#editor")!,
});
```

Semantic tokens are opt-in because they add a request after document changes and
whenever Lean asks the client to refresh. The renderer discovers the server's
legend, decodes LSP positions as UTF-16 offsets, and rejects results for older
document versions or client generations. It maps token types to the active
CodeMirror `HighlightStyle` and also adds stable classes such as
`cm-lean-semantic-function` plus a `data-lean-semantic-token` attribute.

Hosts can add their own classes without replacing the protocol or rendering
layer:

```ts
const client = createLeanLspClient({
  features: {
    semanticTokens: {
      className(token) {
        return token.modifiers.includes("deprecated") ? "my-deprecated-token" : null;
      },
    },
  },
});
```

To observe Lean's per-file processing ranges, add the Lean progress extension to
the session's client configuration. The session clears connection-scoped state
when it disconnects, reconnects, or is disposed.

```ts
import { createLeanEditorSession, leanFileProgress } from "codemirror-lean4-lsp";

const progress = leanFileProgress({
  onUpdate(update) {
    console.log(update.uri, update.state?.processing.length ?? 0);
  },
});

const session = createLeanEditorSession({
  client: {
    extensions: [progress],
  },
});
```

`session.reconnect(transport)` creates a fresh client generation. Editor views
configured through `lean4({ session, uri })` keep their CodeMirror state and
replace only the LSP plugin after the new generation is ready. Use
`createLeanLspClient()` directly only when the host already owns equivalent
connection, editor rebinding, and extension cleanup.

## Optional Lean infoview

The official Lean infoview bridge is available from an optional browser-only
subpath. Install the renderer peer and import its stylesheet explicitly:

```bash
npm install codemirror-lean4-lsp @leanprover/infoview react react-dom
```

```ts
import type { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";
import "codemirror-lean4-lsp/infoview.css";

declare const activeUri: string | null;
declare const activeView: EditorView | null;
declare const reconnectLean: (reason: string) => void;

let infoview: LeanInfoviewHost | null = null;
const workspace = createLeanWorkspace();
const session = createLeanEditorSession({
  client: {
    extensions: [
      leanInfoviewClientNotifications(() => infoview),
    ],
    workspace,
  },
});

infoview = createLeanInfoviewHost({
  client: () => session.client,
  container: document.querySelector("#infoview")!,
  currentLanguageId: () => "lean4",
  currentUri: () => activeUri,
  currentView: () => activeView,
  requestRestart: reconnectLean,
  workspace: () => (session.client?.workspace as LeanWorkspace | undefined) ?? null,
});
```

The host owns Lean RPC sessions, notification subscriptions, cursor updates,
cross-file edits, and renderer lifecycle. Add `infoview.editorExtension()` to
each Lean editor and call `serverRestarted()`, `serverStopped()`, and
`updateCursorLocation()` from the corresponding host lifecycle events. The main
package entry does not import the infoview renderer.

If you want standard editor ergonomics such as undo/history, search, folding, and line numbers, enable utilities explicitly:

```ts
import { lean4 } from "codemirror-lean4-lsp";

const extensions = lean4({
  client,
  uri: "file:///workspace/Main.lean",
  utilities: {
    lineWrapping: true,
  },
});
```

For multi-file hosts, provide a custom workspace built on CodeMirror's official `Workspace` API:

```ts
import {
  applyLeanWorkspaceEdit,
  createLeanLspClient,
  createLeanWorkspace,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import type {
  RenameParams,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

const client = createLeanLspClient({
  rootUri: "file:///workspace",
  workspace: createLeanWorkspace({
    async loadDocument(uri) {
      return { doc: await fetchDocFromBackend(uri) };
    },
    async displayDocument(uri) {
      return openEditorForUri(uri);
    },
  }),
});

const workspace = client.workspace as LeanWorkspace;
const lease = await workspace.acquireServerDocument(
  "file:///workspace/Generated.lean",
);
try {
  // The document stays open in Lean even without an editor view.
  client.sync();
} finally {
  lease?.release();
}
await workspace.unloadDocument("file:///workspace/Generated.lean");

client.sync();
await client.withMapping(async (mapping) => {
  const edit = await client.request<RenameParams, WorkspaceEdit | null>(
    "textDocument/rename",
    renameParams,
  );
  if (!edit) return;
  const result = await applyLeanWorkspaceEdit(client, edit, {
    mapping,
    userEvent: "rename",
  });
  if (!result.applied) throw new Error(result.failureReason);
});
```

`requestFile()` loads a document into the workspace cache without opening it in
Lean. `acquireServerDocument()` returns an independent lease that keeps it open
in Lean without an editor; releasing the last owner flushes pending edits before
`didClose`. `unloadDocument()` removes an unowned cached document and reports
`"unloaded"`, `"in-use"`, or `"not-loaded"` after in-flight loading and host
change callbacks have settled.

The default Lean keymaps use `leanJumpToDefinition` and `leanRenameSymbol`.
They handle Lean's `LocationLink` definition responses, load cross-file targets
through the workspace, and route rename edits through
`applyLeanWorkspaceEdit()`. The edit helper validates every target before
mutation and supports LSP `changes` plus text-only `documentChanges`; filesystem
resource operations remain a host responsibility.

`LeanWorkspace` intentionally allows only one editor view per URI. A host that
needs split views should share one CodeMirror state between those views or
provide its own `Workspace` implementation.

## Notes

- The default client configuration composes official CodeMirror features with Lean-aware navigation and rename commands.
- If you need finer control, pass `features` to `createLeanLspClient()` or import the official passthrough exports from `codemirror-lean4-lsp/codemirror`.
- The package does not start Lean itself. The embedding app owns transport and process lifecycle.
- LSP Markdown can contain raw HTML. Production hosts should pass a trusted `sanitizeHTML`
  function to `createLeanLspClient()` before enabling hover or signature documentation.
- Repository, issue tracker, and release metadata point to `ejgallego/lean-mirror` on GitHub.
- API, release policy, and backlog docs live in [docs/README.md](./docs/README.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [docs/BACKLOG.md](./docs/BACKLOG.md).

## Demo

The demo expects `lean`, `lake`, and `rust-analyzer` on `PATH`. The repository and
demo workspace pin Lean 4.33.0-rc1; an elan installation selects and installs that
toolchain automatically. `rust-analyzer` can be installed with
`rustup component add rust-analyzer rust-src`. External Anneal mode also needs
`cargo` and a checkout of the Rust project whose examples you want to open.

If the Lean WebSocket closes, the demo starts a fresh client/server generation
without remounting the active CodeMirror editor. A complete runtime restart is
retained as the fallback when generation recovery itself fails.

Install the npm dependencies if needed, then start the in-repo sample workspace:

```bash
npm install
npm run demo
```

Open `http://127.0.0.1:5173`. The all-in-one script starts:

- a Vite frontend in `demo/`
- a small WebSocket bridge that proxies browser JSON-RPC frames to `lake env lean --server`
- a rust-analyzer bridge for the active Rust source
- a multi-file editor demo that can switch between the default Lean files, the Rust source, and the synthesized Lean snippet document
- a pure Rust-driver path where edits to `Main.rs` refresh `RustSnippets.lean` without importing generated Aeneas output

If those ports are busy, override them:

```bash
DEMO_BACKEND_PORT=7358 DEMO_FRONTEND_PORT=5174 npm run demo
```

The backend binds to loopback by default. Directly binding it to a non-loopback address is refused
unless `LEAN_DEMO_ALLOW_REMOTE=1` is set. Remote mode is intended only for controlled experiments;
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

The built-in `zerocopy-pr3321` presets are:

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
- `LEAN_DEMO_EXAMPLE_SET=zerocopy-pr3321`: enable the built-in zerocopy presets
- `LEAN_DEMO_ACTIVE_EXAMPLE`: choose the startup preset, for example `namespaces`
- `LEAN_DEMO_EXAMPLE_PRESETS`: JSON array of custom presets with `id`, `label`, `rustFile`, optional `summary`, and optional `annealArgs`
- `LEAN_DEMO_SKIP_LEAN_BUILD=1`: skip `lake exe cache get` and `lake build` for an external Lean workspace
- `DEMO_WATCH_USE_POLLING=0`: opt out of the default polling Vite watcher and use native filesystem watches
- `PLAYWRIGHT_BROWSERS_PATH`: browser cache for E2E tests; defaults to `.demo-cache/playwright-browsers`
