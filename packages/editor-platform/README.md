# Editor Platform

`@leanprover/editor-platform` contains editor-agnostic runtime primitives for experimental Lean editing surfaces.

The package is intentionally small at this stage. It defines the status, document, diagnostic, log, and snapshot models that browser demos, VS Code custom editors, and tests can share before any CodeMirror- or ProseMirror-specific code is involved.

## Scope

This package may own:

- service lifecycle status for Lean, Rust, Verso parser, and future bridge services
- document identity and version metadata
- diagnostics and logs in a common shape
- shell/runtime snapshots that editor hosts can render
- lightweight observable state used by demos, VS Code webviews, and tests

This package must not own:

- CodeMirror extensions, workspaces, commands, or keymaps
- ProseMirror schemas, plugins, node views, or reconciliation
- Verso CST projection logic
- browser or VS Code UI components
- concrete process spawning policy until the host/service boundary is clearer

## First Milestone

The first useful milestone is shared status rendering:

- Lean server status
- Rust server status
- active document URI/language/version
- diagnostics summary
- bridge logs

Once both editor shells consume this model, bridge lifecycle code can move here behind the same service abstractions.
