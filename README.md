# CodeMirror Lean 4 LSP

Experimental Lean 4 language-server support for CodeMirror 6, built on the
[official CodeMirror LSP client](https://github.com/codemirror/lsp-client).
It provides editor bindings, document synchronization, connection generations,
and an optional Lean infoview. The embedding application owns language-server
processes and transports. The `0.x` API may change.

## Run the demos

Install **Node 24**, [elan](https://github.com/leanprover/elan#installation),
and [rustup](https://rustup.rs/) first, with their commands on `PATH`.
The demos are currently tested on Linux.

```sh
git clone https://github.com/ejgallego/lean-mirror.git
cd lean-mirror
rustup toolchain install 1.99.0 --profile minimal --component rust-analyzer --component rust-src --component rustfmt
npm ci
RUSTUP_TOOLCHAIN=1.99.0 npm run demo
```

Open **<http://127.0.0.1:5173/>**. Elan selects the pinned Lean 4.35.0 toolchain;
the first launch may download it and builds the native Rosetta host. Rosetta is
bundled, so no separate checkout or Aeneas installation is needed. The demo runs
local Lean and Rust language servers; it needs the Node backend running.

### Lean-first: Rust in a Verso docstring

The default opens `AeneasDemo.lean`: a Rust `bump(&mut u32)` function appears in
the raw, editable Verso docstring on its corresponding Lean definition, followed
by a checked proof. [Rosetta](demo/rosetta/README.md) provides Rust hovers inside
the comment; Lean provides diagnostics, hovers, and the infoview for the Lean code.

This is a **hand-authored Aeneas-style mock-up**. Rust edits do not regenerate
Lean or verify that the two implementations correspond. **Render Rust** in the
gutter opens a preview; **Edit Rust** opens an inline Rust editor with hover,
diagnostics, completion, definition, rename, and formatting. Rust blocks are
isolated snippets. Lean document edits remain in memory.

### Rust-first: Lean in Rust comments

Open **<http://127.0.0.1:5173/?mode=rust>**. `Main.rs` is the main editor, with
rust-analyzer support. Its fenced Lean doc comments become editable inline
blocks with Lean diagnostics, hovers, and the infoview, synchronized through
`RustSnippets.lean`.

This mode saves Rust edits to `Main.rs` and rebuilds `RustSnippets.lean` from its
comments. Preserve manual fixture edits before starting or resetting the demo.

## More

- [Library usage](docs/USAGE.md) and [API reference](docs/API.md)
- [Demo guide](docs/DEMOS.md): rendered mode, other examples, ports, and external Anneal workflows
- [Development and checks](docs/DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)
