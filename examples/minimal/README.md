# Minimal Lean Editor Experiment

This example is the smallest browser host in the repository that combines:

- one CodeMirror Lean document;
- `LeanEditorSession` and `LeanWorkspace` lifecycle ownership;
- the optional official Lean infoview adapter;
- the editor-platform status, event, and workspace shell;
- a session-safe Lean reconnect button.

The browser source imports toolkit features only through `codemirror-lean4-lsp`,
`codemirror-lean4-lsp/infoview`, and `@leanprover/editor-platform`. The Vite
aliases point those package names at this checkout so the unpublished prototype
can be exercised from source without weakening the package boundary.

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

The example deliberately does not contain Rust extraction, external workspace
generation, multi-document navigation, or demo-specific frontend imports. Use
the main demo for those integration scenarios.
