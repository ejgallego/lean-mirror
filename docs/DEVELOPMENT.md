# Development and takeover baseline

## Setup

Use Node 22.12 or newer in the Node 22 line, or Node 24. The library's runtime
engine range is broader than this development baseline. `packageManager` in
`package.json` records npm 11.11.0 for reproducible development and primary CI;
the packaging harness also accepts npm 12 output. Select that npm version in
your Node environment, then run:

```bash
npm ci
npm run playwright:install
npm run check:environment
```

Install elan so `lean` and `lake` select the checked-in `lean-toolchain`
(`leanprover/lean4:v4.34.1`). Install rust-analyzer and Rust sources with
rustup. Primary CI uses Rust 1.89.0:

```bash
rustup toolchain install 1.89.0 --profile minimal --component rust-analyzer --component rust-src
```

Select that toolchain in your shell when matching CI. `npm run check:environment`
requires matching root/demo Lean pins, Lean, Lake, and rust-analyzer on PATH, and
checks Lean against the repository pin. `npm run ci` runs this prerequisite check
first. Focused tests can still run without every integration prerequisite.

## Verification

| Change | Relevant verification |
| --- | --- |
| Library behavior | `npm run check`, affected `npm test -- test/name.test.ts`, `npm run test:consumer` |
| Infoview, editor lifecycle, browser composition | Library checks plus `npm run test:e2e:minimal` |
| Embedded Lean/Rust or demo backend | Affected unit tests plus `npm run test:e2e` |
| Package metadata, exports, or assets | `npm run test:packed`, `npm run pack:check`; use `npm run test:packed:browser` for browser entry changes |
| Shared editor platform | `npm run check:platform`, `npm run test:platform`, `npm run build:platform`, `npm run test:consumer:verso`; validate the real sibling as described below |
| VS Code host adapter | `npm run check:vscode`, `npm run test:vscode`, `npm run build:vscode` |
| Integration or release checkpoint | `npm run ci` |

The full command includes type checks, real Lean tests, demo and minimal browser
tests, production builds, built-package consumers, package contents, and an
isolated production-bundled browser consumer. GitHub CI selects the declared npm
11 version and separately verifies packaging with Node 24 and npm 12.0.2.
Isolated consumer installs revalidate registry metadata while reusing cached
tarballs, so an older local npm cache cannot hide an updated dependency version.

Run browser suites sequentially. Their launchers restore the tracked Rust and
generated Lean demo fixtures before and after each suite. Do not mix them with
a manually edited demo session or another suite in the same checkout. A separate
worktree needs its own `npm ci`; give simultaneous demo sessions distinct ports
using the overrides in the README.

The workspace example (`npm run example:workspace`) exercises file switching,
revision-checked persistence, and server recovery through public package APIs.
Run `npm run test:e2e:workspace` for these workflows; they also run against the
isolated package in `npm run test:packed:browser`. Browser suites reset Main.lean,
Helper.lean, Main.rs, and RustSnippets.lean from their committed baselines.

The three external Anneal scenarios are deliberately skipped in ordinary demo
CI. Run `npm run test:e2e:zerocopy-anneal` for work on generation, cache identity,
or prepared-example switching. This can download external projects and run
long Rust/Lean builds; it is a separate integration gate.

For shared-platform changes, `npm run test:consumer:verso` checks a committed
consumer fixture. With the sibling checkout available, also run:

```bash
npm run test:consumer:verso:workspace
```

Set `VERSO_MIRROR_ROOT` if the sibling is elsewhere. This command runs its check,
tests, and build, and writes build artifacts there. Service synchronization or
bridge changes also need its `npm run test:lsp`. See `editor-platform.md` for
the dependency model.

## Takeover checkpoint

The October 2026 review started from clean `main` at `c5c1f86`. Historical PR work
was already integrated; no branch recovery was needed. The stabilization pass
addresses npm selection and pack-output compatibility, empty document loading,
and synchronous server-to-client handler failures, with focused regressions.

Local validation on Node 24.21.0 passed the full `npm run ci` with npm 11.11.0
and npm 12.0.2. The final runtime revision also passed the full npm 11 command.
Coverage includes 137 root tests, 46 platform tests, 10 adapter tests, the explicit
Verso contract, 14 ordinary demo browser scenarios, and the minimal and packed
browser scenarios. The three external Anneal scenarios remain a separate gate.
The updated GitHub workflow was checked with actionlint, and both hosted CI jobs
passed in [takeover PR #4](https://github.com/ejgallego/lean-mirror/pull/4).

The compatibility follow-up pins stable Lean 4.34.1 and CodeMirror LSP client
6.3.0. Local validation passed the real-server and late-loaded-file mapping tests,
ordinary and minimal browser scenarios, built-package consumers, and the isolated
packed-browser scenario. The workspace mapping adapter remains unchanged because
the upstream workspace implementation is unchanged. Packed-consumer installs now
revalidate metadata after the upgrade exposed a stale npm cache; CI also rejects
drift between the root and demo toolchain pins.

The next product goal should identify a concrete host workflow and its acceptance
criteria. Library experiments can start from `examples/minimal/publicLeanEditor.ts`;
embedded Lean/Rust experiments use the full demo. Shared-package extraction and
external Anneal validation remain separate goals.

Agent guidance stays short and records project-specific boundaries and completion
criteria. Supporting documents are read when relevant to the task. This follows
OpenAI's [guidance on revisiting skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
