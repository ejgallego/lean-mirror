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
- `createLeanWorkspace`
- `LeanWorkspace`
- `LeanWorkspaceFile`
- `createWebSocketTransport`
- `createMessagePortTransport`

These exports define the package-specific contract. Changes to them should be treated as SemVer-significant.

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
