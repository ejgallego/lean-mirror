# Editor Platform Boundary

`@leanprover/editor-platform` should stay as a small support layer for editor shells and host/runtime integration. The package is valuable when it lets `lean-mirror`, `verso-mirror`, browser demos, and future VS Code custom editors agree on state and messages without sharing editor implementation code.

## Shared Now

These APIs are already inside the package and are good examples of the intended boundary:

- service lifecycle and connection status models
- document identity, language, title, version, open state, and sync state helpers
- document-scoped diagnostics, diagnostic summaries, and logs
- observable platform snapshots
- pure shell view models derived from snapshots
- a compact status-panel DOM renderer over the shell view model
- a structural workspace-shell DOM renderer with editor, status, info, and secondary slots
- typed host/editor protocol envelopes and structural message adapters

These APIs should remain pure TypeScript and avoid direct dependencies on CodeMirror, ProseMirror, VS Code, Lean process management, or Verso CST internals. The DOM-facing renderers must stay limited to structural element interfaces, with concrete styling and editor-specific content owned by host apps.

## Maybe Share Later

These are plausible extraction candidates, but should require two real consumers and a clear customization story first:

- request telemetry helpers for LSP and custom bridge calls
- VS Code webview host helpers for message wiring, state publication, and test harnesses
- common document/session test utilities for editor shell demos
- retry/reconnect policy helpers, if Lean, Rust, and Verso bridge runtimes converge on the same behavior

The bar for this category is higher than "two files look similar". Shared code should remove coordination risk without forcing CodeMirror and ProseMirror to compromise their local architecture.

## Keep Local

These should stay in their editor or host repositories:

- CodeMirror extensions, keymaps, commands, workspaces, view plugins, and language packages
- ProseMirror schemas, plugins, node views, command models, reconciliation, and rendering surfaces
- Verso CST parsing, projection, source preservation, and semantic extension logic
- concrete process spawning, toolchain discovery, filesystem layout, and server supervision
- concrete VS Code extension registration, activation, custom editor provider classes, and packaging
- visual design specifics for a particular demo or editor shell

Keeping these local avoids turning `editor-platform` into a framework that owns each editor's product decisions.

## Extraction Checklist

Before adding a new shared API:

1. Identify at least two consumers that would use the same API without adapter glue.
2. Confirm the API can be expressed without CodeMirror, ProseMirror, VS Code, DOM, or process-spawning types.
3. Add focused package tests for the shared behavior.
4. Wire one `lean-mirror` consumer and one `verso-mirror` consumer when possible.
5. Run `npm run check:platform`, `npm run test:platform`, and `npm run build:platform`.
6. Run affected consumer checks in `lean-mirror` and `verso-mirror`.

## Near-Term Backlog

1. Request telemetry:
   Consolidate request timing and failure summaries if both LSP clients and custom bridge calls need the same reporting.

2. VS Code webview wiring:
   Share typed message/state publication helpers before sharing any VS Code extension classes.

3. Test harness utilities:
   Share document/session fixture helpers once both demos exercise the same host protocol shape.
