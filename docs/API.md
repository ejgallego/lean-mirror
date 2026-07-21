# API Surface

## Experimental top-level API

Import these from `codemirror-lean4-lsp`:

- `createLeanLspClient`
- `leanLspExtensions`
- `lean4`
- `leanFallbackLanguage`
- `leanFallbackLanguageSupport`
- `leanFallbackHighlightStyle`
- `leanUtilities`
- `leanFileProgress`
- `leanFileProgressMethod`
- `LeanFileProgressKind`
- `LeanFileProgressStore`
- `createLeanWorkspace`
- `LeanWorkspace`
- `LeanWorkspaceFile`
- `createWebSocketTransport`
- `waitForWebSocketOpen`
- `createMessagePortTransport`

These exports are the current experimental package surface. During `0.x`, they may be renamed,
changed, or removed without aliases or a deprecation window. Pin an exact package version for
experiments that need reproducibility.

`createWebSocketTransport()` reports sends attempted while a socket is still connecting and
ignores terminal sends during teardown. Await `waitForWebSocketOpen()` before connecting an
`LSPClient`. `LeanWorkspace` supports multiple documents but deliberately enforces one editor
view per URI.

The built-in Lean language is deliberately named and documented as a fallback tokenizer. It
provides lightweight comments, literals, identifiers, commands, and punctuation highlighting,
but it is not a complete Lean parser. Language support does not install an opinionated color
theme; pass `{ highlightStyle: leanFallbackHighlightStyle }` or install a host-selected
CodeMirror style.

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
