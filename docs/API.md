# API Surface

## Experimental top-level API

Import these from `codemirror-lean4-lsp`:

- `createLeanLspClient`
- `createLeanEditorSession`
- `leanEditorSessionBinding`
- `LeanEditorSession`
- `LeanEditorSessionDisconnectedError`
- `leanLspExtensions`
- `lean4`
- `leanFallbackLanguage`
- `leanFallbackLanguageSupport`
- `leanFallbackHighlightStyle`
- `leanUtilities`
- `leanSemanticTokens`
- `decodeLeanSemanticTokens`
- `leanSemanticTokensFullMethod`
- `leanSemanticTokensRefreshMethod`
- `leanFileProgress`
- `leanFileProgressMethod`
- `LeanFileProgressKind`
- `LeanFileProgressStore`
- `createLeanWorkspace`
- `LeanWorkspace`
- `LeanWorkspaceFile`
- `LeanServerDocumentLease`
- `LeanWorkspaceUnloadResult`
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

### Workspace document lifecycle

`LeanWorkspace` distinguishes three kinds of state:

- A document returned by `requestFile(uri)` is loaded in the local cache but is
  not open in the LSP connection.
- An editor view owns an LSP-open document until its plugin is destroyed.
- `acquireServerDocument(uri)` creates an independent
  `LeanServerDocumentLease` for a host subsystem that needs Lean to process a
  document without displaying it.

The first owner sends `textDocument/didOpen`. Releasing the last server lease
sends `textDocument/didClose` only when no editor still owns the document.
Pending changes are synchronized before the close; leases are idempotent and
one owner cannot close another owner's document.

`unloadDocument(uri)` waits for an in-flight load and outstanding
`onDocumentChange` callbacks, then returns `"unloaded"`, `"in-use"`, or
`"not-loaded"`. It never destroys an active editor or server lease. Closing a
document does not implicitly unload its cached text, so hosts can navigate back
without fetching it again and can choose their own cache policy.

Edits to cached-but-closed files update the workspace and invoke
`onDocumentChange`, but do not emit an invalid `didChange` without a preceding
`didOpen`. Direct-client disconnects absorb unsynchronized editor and hidden
document changes so a later reconnect reopens their latest full text.

### Session lifecycle

`createLeanEditorSession()` owns one active client generation. `connect()` returns
the generation's `client` and `initialized` promise. `disconnect()` runs
connection-scoped extension and transport cleanup, while `dispose()` permanently
closes the owner.

`reconnect()` always creates a fresh `LSPClient` because the upstream client does
not provide a complete reusable connection lifecycle. Editor views configured
with `lean4({ session, uri })` retain their CodeMirror state while
`leanEditorSessionBinding()` removes the old LSP plugin and installs the new one
only after initialization succeeds. Views configured with a direct `client`
remain owned by their host. Session state moves through `idle`, `initializing`,
`ready`, `failed`, and `disposed`; the generation number lets asynchronous host
code reject stale results.

`session.subscribe(listener, { emitCurrent })` supports multiple lifecycle
observers and returns an unsubscribe function. The constructor-level
`onStateChange` callback remains available for a single primary observer.

Extensions with `onSessionDisconnect(client)` participate in owned teardown.
`leanFileProgress()` implements this hook. Hosts using `createLeanLspClient()`
directly must clear connection-scoped extension state themselves.

The built-in Lean language is deliberately named and documented as a fallback tokenizer. It
provides lightweight comments, literals, identifiers, commands, and punctuation highlighting,
but it is not a complete Lean parser. Language support does not install an opinionated color
theme; pass `{ highlightStyle: leanFallbackHighlightStyle }` or install a host-selected
CodeMirror style.

### Lean semantic tokens

Enable semantic rendering with
`createLeanLspClient({ features: { semanticTokens: true } })`, pass options in
place of `true`, or compose `leanSemanticTokens(options)` explicitly in the
client's `extensions`. It advertises relative semantic-token support, discovers
the server legend, requests `textDocument/semanticTokens/full`, and responds to
Lean's server-initiated `workspace/semanticTokens/refresh` requests.

Decoded offsets use JavaScript and CodeMirror's UTF-16 indexing. Results are
discarded when the document, synchronized workspace version, client generation,
or request serial has changed. In-flight superseded requests are also cancelled.
`decodeLeanSemanticTokens()` exposes the validated decoder for hosts that need
the typed token stream without the built-in renderer.

Rendering maps token kinds and modifiers to the active CodeMirror
`HighlightStyle`. Every mark also receives `cm-lean-semantic-token`, a stable
kind class such as `cm-lean-semantic-function`, modifier classes, and a
`data-lean-semantic-token` attribute. `className(token)` can add host-selected
classes; `onError(error, context)` can replace CodeMirror's default exception
logging. `debounceMs` defaults to 100 milliseconds.

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
