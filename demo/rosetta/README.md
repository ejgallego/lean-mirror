# Rosetta in the Lean demo

Run `npm run demo` and open the frontend. Main.lean imports RustComment and
uses `set_option doc.verso true`. A Rust fence such as
`rust (name := demoWidget)` is therefore accepted by Lean's actual Verso
doc-comment elaborator. The extension records ordinary code; elaboration never
starts a language server.

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
an unchanged, reproducible snapshot. The separate VersoRosetta Manual bridge
is not needed for this Lean doc-comment host.

`demo/server/rosetta.mjs` copies the core and facade into
`.demo-cache/rosetta-host`, preserving unchanged file contents, and runs Lake
there. The host uses the core package's Lean 4.35 toolchain; the surrounding
Lean document uses the demo's Lean 4.34.1 toolchain. Elan selects each pin.

For Rosetta development, select a local checkout once:

```sh
npm run demo:rosetta:checkout -- /path/to/packages/rosetta
```

The selection lives in the ignored `.demo-cache/rosetta-source.json`. Restart
the demo after selecting a different checkout. Subsequent edits to its Lean
modules, Lake configuration, or toolchain trigger a rebuild and browser reload.
`npm run demo:rosetta:checkout -- --reset` restores the bundled fallback.
`LEAN_DEMO_ROSETTA_ROOT` overrides either selection for one command.
Builds write only to this repository's cache, never the selected checkout. `rust-analyzer`, `rust-src`, and `rustfmt` are required. To match CI:

```sh
rustup toolchain install 1.99.0 --profile minimal --component rust-analyzer --component rust-src --component rustfmt
RUSTUP_TOOLCHAIN=1.99.0 npm run demo
```

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
