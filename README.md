# CodeMirror Lean 4 LSP

Lean 4 language support for CodeMirror 6, built around the official `@codemirror/lsp-client`.

The top-level package export is intentionally Lean-focused. If you want raw `@codemirror/lsp-client` building blocks, use the explicit `codemirror-lean4-lsp/codemirror` subpath.

This package stays intentionally thin:

- Lightweight fallback Lean syntax tokenization via `leanFallbackLanguageSupport()`
- Explicit client-generation lifecycle via `createLeanEditorSession()`
- Lean-aware `LSPClient` factory via `createLeanLspClient()`
- Typed Lean `$/lean/fileProgress` tracking via `leanFileProgress()`
- Optional multi-file host workspace via `createLeanWorkspace()`
- Standard editor utilities via `leanUtilities()`
- Browser transport helpers for `WebSocket` and `MessagePort`
- A small `lean4(...)` helper that composes language support with `client.plugin(...)`

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
    rootUri: "file:///workspace",
  },
});

await waitForWebSocketOpen(socket);
const { client, initialized } = session.connect(createWebSocketTransport(socket), {
  disposeTransport() {
    socket.close();
  },
});
await initialized;

const state = EditorState.create({
  doc: "#check Nat.succ\n",
  extensions: lean4({
    client,
    highlightStyle: leanFallbackHighlightStyle,
    uri: "file:///workspace/Main.lean",
  }),
});

new EditorView({
  state,
  parent: document.querySelector("#editor")!,
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

`session.reconnect(transport)` creates a fresh client generation. Destroy or
remount editor views with the returned client; a view must not retain a client
from an older generation. Use `createLeanLspClient()` directly only when the host
already owns equivalent connection and extension cleanup.

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
import { createLeanLspClient, createLeanWorkspace } from "codemirror-lean4-lsp";

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
```

`LeanWorkspace` keeps hidden documents available for server-initiated edits, but intentionally
allows only one editor view per URI. A host that needs split views should share one CodeMirror
state between those views or provide its own `Workspace` implementation.

## Notes

- The default client configuration delegates to CodeMirror's official `languageServerExtensions()` bundle.
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
`rustup component add rust-analyzer rust-src`.

Run `npm run demo` and open `http://127.0.0.1:5173`.

If those ports are busy, override them:

```bash
DEMO_BACKEND_PORT=7358 DEMO_FRONTEND_PORT=5174 npm run demo
```

The backend binds to loopback by default. Directly binding it to a non-loopback address is refused
unless `LEAN_DEMO_ALLOW_REMOTE=1` is set. Remote mode is intended only for controlled experiments;
configure `LEAN_DEMO_ALLOWED_ORIGINS`, payload limits, and the LSP process cap before using it.

That starts:

- a Vite frontend in `demo/`
- a small WebSocket bridge that proxies browser JSON-RPC frames to `lean --server`
- a multi-file editor demo that can switch between `Main.lean`, `Helper.lean`, `Main.rs`, and the concatenated Lean snippets extracted from Rust comments
- a pure Rust-driver path where edits to `Main.rs` refresh `RustSnippets.lean` without importing generated Aeneas output
