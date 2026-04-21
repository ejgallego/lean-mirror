# CodeMirror Lean 4 LSP

Lean 4 language support for CodeMirror 6, built around the official `@codemirror/lsp-client`.

The top-level package export is intentionally Lean-focused. If you want raw `@codemirror/lsp-client` building blocks, use the explicit `codemirror-lean4-lsp/codemirror` subpath.

This package stays intentionally thin:

- Lean syntax/highlighting via `leanLanguageSupport()`
- Lean-aware `LSPClient` factory via `createLeanLspClient()`
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
import { createLeanLspClient, createWebSocketTransport, lean4 } from "codemirror-lean4-lsp";

const socket = new WebSocket("ws://localhost:8080");
const client = createLeanLspClient({
  rootUri: "file:///workspace",
});

client.connect(createWebSocketTransport(socket));

const state = EditorState.create({
  doc: "#check Nat.succ\n",
  extensions: lean4({
    client,
    uri: "file:///workspace/Main.lean",
  }),
});

new EditorView({
  state,
  parent: document.querySelector("#editor")!,
});
```

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

## Notes

- The default client configuration delegates to CodeMirror's official `languageServerExtensions()` bundle.
- If you need finer control, pass `features` to `createLeanLspClient()` or import the official passthrough exports from `codemirror-lean4-lsp/codemirror`.
- The package does not start Lean itself. The embedding app owns transport and process lifecycle.
- URL-specific package metadata such as `repository`/`homepage` is intentionally not set yet because this local repo does not have a configured public remote.
- API, release policy, and backlog docs live in [docs/README.md](./docs/README.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [docs/BACKLOG.md](./docs/BACKLOG.md).

## Demo

Run `npm run demo` and open `http://127.0.0.1:5173`.

If those ports are busy, override them:

```bash
DEMO_BACKEND_PORT=7358 DEMO_FRONTEND_PORT=5174 npm run demo
```

That starts:

- a Vite frontend in `demo/`
- a small WebSocket bridge that proxies browser JSON-RPC frames to `lean --server`
- a multi-file editor demo that can switch between `Main.lean` and `Helper.lean`
