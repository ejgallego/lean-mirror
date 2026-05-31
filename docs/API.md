# API Surface

## Stable top-level API

Import these from `codemirror-lean4-lsp`:

- `createLeanLspClient`
- `leanLspExtensions`
- `lean4`
- `leanLanguage`
- `leanLanguageSupport`
- `leanHighlightStyle`
- `leanUtilities`
- `leanFileProgress`
- `leanFileProgressMethod`
- `LeanFileProgressKind`
- `LeanFileProgressStore`
- `createLeanWorkspace`
- `LeanWorkspace`
- `LeanWorkspaceFile`
- `createWebSocketTransport`
- `createMessagePortTransport`

These exports define the package-specific contract. Changes to them should be treated as SemVer-significant.

### Lean file progress

`leanFileProgress()` creates a small `LSPClientExtension` for Lean's
`$/lean/fileProgress` notification. It tracks per-document processing ranges in a
`LeanFileProgressStore` and calls `onUpdate` when Lean reports new progress or an
empty `processing` array that clears a document's progress.

The exported Lean progress types model Lean's protocol shape:

- `textDocument` is a versioned text document identifier.
- `processing` contains range-bearing items.
- `LeanFileProgressKind.Processing` is `1`.
- `LeanFileProgressKind.FatalError` is `2`.

Stale progress notifications are ignored by default when the workspace already
has a newer document version. Pass `{ acceptStaleVersions: true }` if a host
application deliberately wants to observe older server updates.

## Official CodeMirror passthrough

Import these from `codemirror-lean4-lsp/codemirror` when you want direct access to official `@codemirror/lsp-client` APIs such as:

- `LSPClient`
- `LSPPlugin`
- `Workspace`
- `serverCompletion`
- `serverDiagnostics`
- `hoverTooltips`
- `renameSymbol`
- `jumpToDefinition`

This subpath exists so the top-level package can stay narrowly Lean-focused while still exposing the official CM6 LSP building blocks.

## Internal policy

Do not add implementation-only helpers to the top-level export.

If a helper only exists to support tests, demo infrastructure, or local packaging scripts, keep it unexported.
