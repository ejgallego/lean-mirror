# Rosetta in the Lean demo

Run `npm run demo` and open the frontend. AeneasDemo.lean imports RustComment and
uses `set_option doc.verso true`. A Rust fence such as
`rust (name := demoWidget)` is therefore accepted by Lean's actual Verso
doc-comment elaborator. The extension records ordinary code; elaboration never
starts a language server.

The default example is a static Aeneas-style mock-up: a Rust `bump(&mut u32)`
docstring is attached to its corresponding Lean `bump` definition. The shape
follows [Aeneas's mutable-input increment example](https://github.com/AeneasVerif/aeneas/blob/main/tests/lean/Tutorial/Tutorial.lean).
`AeneasModel.lean` is a small hand-authored model, not the Aeneas runtime: `U32`
uses Lean's `UInt32`, `Result` uses `Except`, and addition checks the overflow
bound. The theorem proves a mathematical increment under that bound, without
`sorry`. Rust edits update only the docstring and Rosetta overlay; they do not
regenerate or validate correspondence with the Lean model. The UI labels the
pair Static mock-up. `?example=basic` opens the original Main.lean example.

The default shows the raw, editable Verso comment. Rust names have Rosetta
hovers directly in that source; hover ranges map only to Rust body lines, with
UTF-16 and CRLF positions preserved. A lazily opened server-document lease
holds the Rust overlay without a hidden editor. Each host view owns at most one
source-hover session, retired on a block switch, view close, or rendering toggle.
Edits synchronize the overlay; old responses cannot appear after an edit.

Render Rust in the gutter opens the retained rendered view. Rosetta supplies
semantic spans, hover results, and versioned diagnostics. Edit Rust reveals the inline
CodeMirror editor; Preview Rust returns to the rendered view. The same editor
state survives those toggles and a Rosetta reconnection. Nested edits replace
only their fence inside the authoritative Lean editor buffer, keeping the
surrounding prose. Show Verso source in the gutter returns to raw editing, and
`?view=rendered` starts with rendering enabled. The full six-feature Rust editing
workflow remains in the inline editor. Lean buffers remain in memory; disk saves
for Lean files are demonstrated by `npm run example:workspace`.

## Host boundary

- The browser's Rust adapter owns its UI, source synchronization, and one
  connection generation at a time.
- Each widget gets an independent temporary Cargo workspace and session key.
  These are isolated snippets, without an external project's dependencies.
- The Node backend relays LSP to the demo-owned RosettaBridge executable.
- Rosetta owns rust-analyzer, versioned document handles, request cancellation,
  deadlines, protocol validation, and process-group cleanup.
- The facade translates Rosetta document versions into browser diagnostic
  versions, normalizes LocationLink definitions and text-only rename results
  for the pinned CodeMirror commands, and exposes decoded preview spans.
- Definition and rename cover the embedded Rust document. Project-wide files,
  filesystem operations, and extraction into Lean are separate workflows.

The public library entry, the shared editor-platform packages, and the core
Lean toolchain pin have no new dependencies.

## Source and build

The [vendored core provenance](vendor/UPSTREAM.md) identifies the upstream
revision and Apache-2.0 license. This package is unpublished, so the demo keeps
a reproducible snapshot with the documented server-status patch. The separate VersoRosetta Manual bridge
is not needed for this Lean doc-comment host.

`demo/server/rosetta.mjs` copies the core and facade into
`.demo-cache/rosetta-host`, preserving unchanged file contents, and runs Lake
there. The root project, demo workspace, and bundled core all use Lean 4.35.0.
An override checkout supplies its own host toolchain pin, selected by elan.

For Rosetta development, select a local checkout once:

```sh
npm run demo:rosetta:checkout -- /path/to/packages/rosetta
```

The selection lives in the ignored `.demo-cache/rosetta-source.json`. Restart
the demo after selecting a different checkout. Subsequent edits to its Lean
modules, Lake configuration, or toolchain trigger a rebuild and browser reload.
`npm run demo:rosetta:checkout -- --reset` restores the bundled fallback.
`LEAN_DEMO_ROSETTA_ROOT` overrides either selection for one command.
Builds write only to this repository's cache, never the selected checkout.
Run `npm run demo:setup` to install the pinned tools and build the demos, then
`npm run demo` to start them.

The separate Rust driver is available at `/?mode=rust`. The Anneal wrapper
continues to open its configured external Rust source.

## Verification

```sh
RUSTUP_TOOLCHAIN=1.99.0 npm run test:rosetta
npm run check
RUSTUP_TOOLCHAIN=1.99.0 npm run test:e2e
```

The native contract covers hover, diagnostics, completion, definition, rename,
formatting, Unicode/CRLF positions, versioned Cargo diagnostics, and shutdown.
Browser scenarios exercise the corresponding keybindings, comment round trips,
preview toggles, and reconnection. Run browser suites sequentially because
launchers reset the shared demo fixtures.

## Editing contract

The host document owns authored text. Inline edits replace the fenced body and
preserve the comment kind, fence text, indentation, line endings, and surrounding
prose. The local scanner recognizes complete triple-backtick fences with
standalone comment delimiters, outside Lean strings and ordinary/nested comments.
A single balanced lexical pass supplies both comment boundaries; inline closers
and incomplete comments stay raw. Before applying an inner transaction, the host
validates the current projection and reparses the replacement. Rust containing
`-/`, unmatched `/-`, or a closing fence may not fit inside this representation.
Such nested edits are rejected with an explanation; edit the raw host source or
use a separate source file rather than silently changing Rust semantics.
Other Verso forms remain raw source; successful elaboration is not required for
editing. A projection is cached per adapter/source revision and shared by hover
and decoration consumers. Lean's parsed syntax can enrich this boundary later.

Each Rust presentation uses the demo-local `RustSessionOwner`. Disposal cancels
acquisition and requests, closes the transport, and releases the backend lease.
Unclaimed allocations expire after a minute. Connected workspaces are removed
after the child exits and queued writes finish. Session identities never revive.
The independent Rust driver starts only when its document is opened. Both paths
share `ConnectionScope`: one pending acquisition, an explicit generation, and
idempotent cleanup including resources that arrive after retirement. Failed
startup can be retried with a new scope. Retained editor states preserve undo;
active document reads and saves use the live view, and reopening it is a no-op.

Rosetta's `rosetta/ready` reports rust-analyzer's explicit workspace-loading
state; empty hover/token responses remain valid results. The documented core
patch retains the latest status beyond notification-journal capacity. Diagnostic
tickets distinguish the owning connection from authored revisions and wire
versions. The reverse demo sends Rust source and disk revision; the server derives
the saved Lean projection with the same pure extractor used by the browser.
`test:rosetta` runs the upstream mock lifecycle tests and the native host contract.

## Persistence and generation

`/rust-main` returns the committed disk revision even when writing the disposable
Lean projection fails (`projectionError`). The browser adopts that source receipt
before reporting the derived-work error. It marks the source clean only if the
acknowledged authored revision is still current. Conflicts with other writers
remain errors and never silently adopt another writer's revision.

Regeneration first obtains a source-save receipt, then submits that acknowledged
snapshot. The generation endpoint validates the receipt and does not save source.
A generator failure leaves the committed revision usable for corrective edits.
If the author edits again while generation runs, the UI retains those newer edits
and does not restart into the older generated snapshot.

The Rosetta facade admits only `src/lib.rs` in its supplied workspace. A second
open or inconsistent lifecycle URI terminates the invalid session. Advertised
capabilities and supported requests are limited to the single-document features;
workspace operations, completion resolution and semantic-token range/delta modes
are not advertised. WebSocket allocations are claimed only after a successful
handshake, when cleanup responsibility can transfer to the child process.
