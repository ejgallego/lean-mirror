# Minimal Lean Editor Experiment

This example is the smallest browser host in the repository that combines:

- one CodeMirror Lean document;
- `LeanEditorSession` and `LeanWorkspace` lifecycle ownership;
- the optional official Lean infoview adapter;
- the editor-platform status, event, and workspace shell;
- a session-safe Lean reconnect button.

The browser source imports the published toolkit through
`codemirror-lean4-lsp` and `codemirror-lean4-lsp/infoview`. It also composes the
currently private `@leanprover/editor-platform` workspace prototype. Shared Vite
aliases point those package names at this checkout so both the public boundary
and private shell experiment can be exercised from source.

This repository example is not included in the npm tarball and is not yet a
standalone application template. External hosts should install the public
package entries and supply their own process supervision and shell.

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

The bundled backend is loopback-only development infrastructure. A production
host should also configure a trusted `sanitizeHTML` function as described in
the root package documentation.

The example deliberately does not contain Rust extraction, external workspace
generation, multi-document navigation, or demo-specific frontend imports. Use
the main demo for those integration scenarios.
