# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog. The `0.x` series is intentionally unstable and does not
provide public-API compatibility guarantees. Normal SemVer compatibility begins at `1.0.0`.

## Unreleased

### Added

- Initial Lean 4 CodeMirror 6 package built on top of `@codemirror/lsp-client`
- Lean language support, browser transport helpers, host-managed workspaces, utilities, demo app, and automated tests
- Typed Lean `$/lean/fileProgress` tracking via `leanFileProgress()`, `LeanFileProgressStore`, and `LeanFileProgressKind`.
- Opt-in Lean semantic-token decoding and CodeMirror rendering with capability negotiation, refresh handling, stale-result rejection, and host-controlled classes.
- Independent `LeanServerDocumentLease` ownership and explicit cached-document unloading through `LeanWorkspace.unloadDocument()`.
- Atomic cross-file text edits through `applyLeanWorkspaceEdit()`, with request-time mapping, version/range validation, late target loading, and `changes`/`documentChanges` support.
- Lean-aware navigation and rename commands that handle `LocationLink` responses and host-loaded target documents.
- Internal WorkDoneProgress handling for demo rust-analyzer progress without conflating it with Lean file-processing ranges.
- Additional mocked LSP and embedded editing regression coverage for hover, formatting, rename, references, progress, session failure recovery, CRLF fenced blocks, duplicate labels, round trips, and diagnostic remapping.
- Explicit WebSocket readiness handling through `waitForWebSocketOpen()`.
- First-class `LeanEditorSession` ownership for initialization state, teardown, and fresh-client reconnection.
- Session-aware `leanEditorSessionBinding()` and state subscriptions for swapping ready LSP client generations without remounting CodeMirror views.
- A built-package consumer experiment covering public exports with deterministic and real `lean --server` transports, including references, rename, semantic tokens, file progress, and versioned diagnostic recovery.
- Explicit `leanFallbackLanguage`, `leanFallbackLanguageSupport`, and `leanFallbackHighlightStyle` exports without compatibility aliases.
- Runtime payload validation for every editor-platform protocol message.
- Shared `EditorServiceRuntime.trackRequest()` telemetry for LSP and custom bridge requests.
- Correlated `command-result` acknowledgements for typed VS Code webview commands.
- Demo security tests for origin, bind-address, body-size, and HTML sanitization policy.
- Optional `codemirror-lean4-lsp/infoview` and `infoview.css` subpaths for the official Lean infoview bridge, RPC lifecycle, notifications, navigation, editing, and outer-shell mounting.
- An isolated packed-tarball consumer gate covering core-only and optional-infoview dependency installation, public types, runtime imports, and infoview assets.
- An opt-in external Anneal demo with generated-workspace caching, switchable Zerocopy examples, Rust-host freshness tracking, and manual or automatic regeneration.

### Changed

- Root validation and the demo workspace now share the Lean 4.33.0-rc1 toolchain pin.
- The demo now reconnects Lean client/server generations while preserving the active editor document, selection, and undo history.
- Server-owned workspace documents now use `acquireServerDocument()` leases; the former unowned `openServerDocument()` operation was removed during the unstable `0.x` series.
- Refreshed the compatible CodeMirror dependency family and pinned `@codemirror/lsp-client` 6.2.5 while the workspace mapping adapter depends on its guarded internal registries.
- Default Lean extensions now compose cross-file-aware navigation and rename commands instead of returning the unmodified upstream bundle.
- `leanFileProgress()` cleanup is driven by `LeanEditorSession`; direct `createLeanLspClient()` users own extension cleanup.
- The demo now owns its Lean client, progress state, and WebSocket through `LeanEditorSession`, including unload/reload coverage.
- The demo infoview now delegates workspace edits to `applyLeanWorkspaceEdit()` instead of maintaining a second permissive edit engine.
- Infoview client-notification forwarding now uses a generation-scoped transport extension instead of mutating each `LSPClient.notification` method.
- The Lean formatting keymap is opt-in because Lean 4.33.0-rc1 does not advertise document formatting; custom servers can enable it with `features.formatKeymap`.
- Embedded fenced-block parsing now preserves correct UTF-16 offsets on CRLF input and gives duplicate labels stable generated keys.
- Lean fallback language support leaves syntax colors to the host unless a `highlightStyle` is supplied.
- `LeanWorkspace` explicitly supports one editor view per URI and rejects divergent duplicate views.
- React and the infoview renderer remain outside the main runtime dependency graph; the extracted infoview subpath declares `@leanprover/infoview` as an optional peer.
- Updated the demo/test toolchain to patched `ws`, Vite, Vitest, and jsdom releases.
- Demo source imports for public toolkit features now resolve through the package entry point so the demo exercises the supported boundary.

### Fixed

- WebSocket transport sends now report connecting sockets instead of silently dropping JSON-RPC messages, while terminal teardown sends remain harmless.
- Hidden workspace edits coalesce into one immutable, correctly versioned LSP update; no-op edits no longer advance versions.
- Cached-but-closed files no longer emit `didChange` without `didOpen`; pending edits are flushed before close and preserved across direct-client reconnection.
- References now retain valid mappings for documents loaded after a request starts, including subsequent cached-document changes.
- Definition navigation accepts Lean 4.33 `LocationLink` responses instead of assuming legacy `Location` fields.
- VS Code document commands are serialized per URI and stale versioned changes are ignored.
- Hostless editor-platform shells report `Ready` when all services are ready.
- Rust and generated-Lean diagnostic results are rejected when they belong to an older edit generation.
- Rebased demo error responses retain origin-aware CORS headers, and clean worktrees resolve the private editor-platform test package directly from source.

### Security

- Sanitized all custom LSP hover HTML with a conservative allowlist.
- Restricted the demo backend to loopback by default, added browser-origin checks, bounded HTTP and WebSocket payloads, and capped concurrent LSP processes.

### Removed

- Removed the ambiguous `leanLanguage`, `leanLanguageSupport`, and `leanHighlightStyle` exports; the fallback-named API replaces them during the unstable `0.x` series.
- Removed the unused legacy `@codemirror/stream-parser` dependency and its CodeMirror 0.19 subtree.
