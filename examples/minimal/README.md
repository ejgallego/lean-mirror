# Minimal Lean Editor Experiment

This example is the smallest browser host in the repository that combines:

- one CodeMirror Lean document;
- `LeanEditorSession` and `LeanWorkspace` lifecycle ownership;
- the optional official Lean infoview adapter;
- a copyable editor composition that imports only public package entries;
- the private editor-platform status, event, and workspace shell;
- a session-safe Lean reconnect button.

[`publicLeanEditor.ts`](./publicLeanEditor.ts) is the reusable boundary. It
mounts CodeMirror, `LeanEditorSession`, `LeanWorkspace`, WebSocket transport,
and the official infoview using only the published toolkit entries and their
direct peer dependencies. [`main.ts`](./main.ts) is deliberately a separate
repository shell adapter: it fetches the demo backend session and renders the
currently private `@leanprover/editor-platform` prototype.

Shared Vite aliases exercise the package boundary from source in this example.
The packed-browser gate copies the exact `publicLeanEditor.ts` module into an
isolated Vite app, installs the generated npm tarball without aliases or
workspace packages, makes a production bundle, and runs the same real-Lean
startup, diagnostics, infoview, editing, and reconnect scenario.

This repository example is not included in the npm tarball and is not a
versioned application template. During `0.x`, adapt the composition at an exact
package version; its public API may change without compatibility aliases.

From the repository root, run:

```bash
npm run example:minimal
```

Then open `http://127.0.0.1:5273`. The repository's demo backend supplies the
local `lake env lean --server` WebSocket bridge and a single displayed
`Helper.lean` document. Override the ports with `MINIMAL_BACKEND_PORT` and
`MINIMAL_FRONTEND_PORT`.

To verify the standalone browser bundle without starting the Lean backend, run:

```bash
npm run build:example:minimal
```

Run its focused browser lifecycle coverage with:

```bash
npm run test:e2e:minimal
```

Run the external-consumer proof with:

```bash
npm run test:packed:browser
```

## External host recipe

1. Install `codemirror-lean4-lsp`, `@leanprover/infoview`, React, CodeMirror
   state/view, and `vscode-languageserver-protocol` as direct dependencies.

   ```bash
   npm install codemirror-lean4-lsp @leanprover/infoview react react-dom \
     @codemirror/state @codemirror/view vscode-languageserver-protocol
   ```

2. Copy or adapt `publicLeanEditor.ts`; provide editor and infoview containers,
   the initial Lean document, workspace root URI, and a WebSocket URL.
3. Own the backend boundary in the application shell. It must supervise
   `lean --server`, bridge JSON-RPC over the WebSocket, and load any additional
   workspace document requested by the editor.
4. Wire the callbacks into the host's status, diagnostic, persistence, and
   reconnection UI. Supply a trusted `sanitizeHTML` function in production.

The isolated app in [`test/packed-consumer`](../../test/packed-consumer) is the
executable reference for package installation and bundling. It intentionally
uses a small local shell rather than the private editor-platform package.

The bundled backend is loopback-only development infrastructure. A production
host should also configure a trusted `sanitizeHTML` function as described in
the root package documentation.

The example deliberately does not contain Rust extraction, external workspace
generation, multi-document navigation, or demo-specific frontend imports. Use
the main demo for those integration scenarios.
