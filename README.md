# CodeMirror Lean 4 LSP

Experimental **Lean 4 support for CodeMirror 6**, with diagnostics, hovers,
navigation, completion, and an optional Lean infoview. The demos also explore
**CodeMirror inside CodeMirror**: editable code blocks with their own language
servers, embedded in another editor's document.

## Two demos

- **Rust in Lean** — a Lean editor with Rust inside a Verso docstring. Hover the
  raw Rust source, or choose **Render Rust**, then **Edit Rust** to open a nested
  editor with Rust diagnostics, completion, navigation, rename, and formatting.
  The example pairs Rust with a hand-authored Aeneas-style Lean translation and
  proof; Rust edits do not regenerate Lean.
- **Lean in Rust** — a Rust editor whose Lean doc comments become nested Lean
  editors, with diagnostics, hovers, and the infoview.

The nested editor integration currently lives in the demos. The library builds
on the [official CodeMirror LSP client](https://github.com/codemirror/lsp-client);
applications supply their language-server processes and transports. The `0.x`
API may change.

## Run the demos

Install **Node 24**, [elan](https://github.com/leanprover/elan#installation),
and [rustup](https://rustup.rs/), with their commands on `PATH`. Currently tested
on Linux.

```sh
git clone https://github.com/ejgallego/lean-mirror.git
cd lean-mirror
npm run demo:setup
npm run demo
```

Setup installs the pinned Lean and Rust toolchains, JavaScript dependencies,
and builds the examples and bundled Rosetta host. Allow time and disk space for
the first download and native build. No separate Rosetta or Aeneas installation
is needed. Rerun setup after updating the checkout; builds reuse local caches.

- **Rust in Lean:** <http://127.0.0.1:5173/>
- **Lean in Rust:** <http://127.0.0.1:5173/?mode=rust>

Keep the terminal running; Ctrl-C stops the servers. Lean-first document edits
stay in memory. Rust-first edits save `Main.rs` and regenerate `RustSnippets.lean`;
preserve manual fixture edits before starting that mode or resetting the demo.

## More

- [Library usage](docs/USAGE.md) and [API reference](docs/API.md)
- [Demo guide](docs/DEMOS.md): setup, rendered mode, ports, and external Anneal workflows
- [Development and checks](docs/DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)
