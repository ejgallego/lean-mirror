# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog. The `0.x` series is intentionally unstable and does not
provide public-API compatibility guarantees. Normal SemVer compatibility begins at `1.0.0`.

## Unreleased

### Added

- Initial Lean 4 CodeMirror 6 package built on top of `@codemirror/lsp-client`
- Lean language support, browser transport helpers, host-managed workspaces, utilities, demo app, and automated tests
- Typed Lean `$/lean/fileProgress` tracking via `leanFileProgress()`, `LeanFileProgressStore`, and `LeanFileProgressKind`.
- Internal WorkDoneProgress handling for demo rust-analyzer progress without conflating it with Lean file-processing ranges.
- Additional mocked LSP and embedded editing regression coverage for hover, formatting, rename, references, progress, CRLF fenced blocks, duplicate labels, round trips, and diagnostic remapping.
- Explicit WebSocket readiness handling through `waitForWebSocketOpen()`.
- First-class `LeanEditorSession` ownership for initialization state, teardown, and fresh-client reconnection.
- A built-package consumer experiment covering public exports with deterministic and real `lean --server` transports, including references, rename, and versioned diagnostic recovery.
- Explicit `leanFallbackLanguage`, `leanFallbackLanguageSupport`, and `leanFallbackHighlightStyle` exports without compatibility aliases.
- Runtime payload validation for every editor-platform protocol message.
- Demo security tests for origin, bind-address, body-size, and HTML sanitization policy.

### Changed

- `leanFileProgress()` cleanup is driven by `LeanEditorSession`; direct `createLeanLspClient()` users own extension cleanup.
- The demo now owns its Lean client, progress state, and WebSocket through `LeanEditorSession`, including unload/reload coverage.
- Embedded fenced-block parsing now preserves correct UTF-16 offsets on CRLF input and gives duplicate labels stable generated keys.
- Lean fallback language support leaves syntax colors to the host unless a `highlightStyle` is supplied.
- `LeanWorkspace` explicitly supports one editor view per URI and rejects divergent duplicate views.
- Demo-only React, infoview, lint, and Markdown packages are development dependencies rather than published runtime dependencies.
- Updated the demo/test toolchain to patched `ws`, Vite, Vitest, and jsdom releases.

### Fixed

- WebSocket transport sends now report connecting sockets instead of silently dropping JSON-RPC messages, while terminal teardown sends remain harmless.
- Hidden workspace edits coalesce into one immutable, correctly versioned LSP update; no-op edits no longer advance versions.
- VS Code document commands are serialized per URI and stale versioned changes are ignored.
- Hostless editor-platform shells report `Ready` when all services are ready.
- Rust and generated-Lean diagnostic results are rejected when they belong to an older edit generation.

### Security

- Sanitized all custom LSP hover HTML with a conservative allowlist.
- Restricted the demo backend to loopback by default, added browser-origin checks, bounded HTTP and WebSocket payloads, and capped concurrent LSP processes.

### Removed

- Removed the ambiguous `leanLanguage`, `leanLanguageSupport`, and `leanHighlightStyle` exports; the fallback-named API replaces them during the unstable `0.x` series.
- Removed the unused legacy `@codemirror/stream-parser` dependency and its CodeMirror 0.19 subtree.
