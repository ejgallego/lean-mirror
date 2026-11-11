# CodeMirror Lean 4 LSP

This project brings **Lean 4 support to CodeMirror 6**, including diagnostics,
hovers, navigation, and completion. It also integrates
[Lean's upstream infoview](https://github.com/leanprover/vscode-lean4)
for exploring goals and messages.

The demos explore **CodeMirror inside CodeMirror**: edit Rust inside a Lean
comment, or Lean inside a Rust comment, with language support in both editors.

## Two demos

- **Rust in Lean** — a Rust function appears in a Verso docstring beside its Lean
  translation and proof. Hover the Rust source directly, or open it in a nested
  editor. The translation is a hand-authored Aeneas-style example; editing Rust
  does not regenerate Lean.
- **Lean in Rust** — Lean code in Rust doc comments opens in nested Lean editors.
  Edit the Lean code and see Lean's messages in the infoview.

## Run the demos

Install **Node 24**, [elan](https://github.com/leanprover/elan#installation),
and [rustup](https://rustup.rs/), and make sure their commands are on `PATH`.
We currently test the demos on Linux.

```sh
git clone https://github.com/ejgallego/lean-mirror.git
cd lean-mirror
npm run demo:setup
npm run demo
```

Setup installs the Lean and Rust versions the demos use, installs the JavaScript
dependencies, and builds the examples. The first setup can take a few minutes
while it downloads the tools and builds Rosetta, which provides Rust support
inside Lean comments. You don't need a separate Rosetta or Aeneas installation.
Run setup again after pulling updates; it reuses previous downloads and builds.

- **Rust in Lean:** <http://127.0.0.1:5173/>
- **Lean in Rust:** <http://127.0.0.1:5173/?mode=rust>

Keep the terminal running while you try the demos; Ctrl-C stops the servers.
The Rust-in-Lean demo keeps your changes in memory. The Lean-in-Rust demo writes
changes to the sample files, so back up any changes you want to keep before
starting that mode or resetting the demo.

## More

- [Library usage](docs/USAGE.md) and [API reference](docs/API.md) — the `0.x` API may change
- [Demo guide](docs/DEMOS.md): setup, rendered mode, ports, and external Anneal workflows
- [Development and checks](docs/DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)
