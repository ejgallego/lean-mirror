# Working in lean-mirror

This repository provides experimental Lean 4 support for CodeMirror 6. Hosts own
language-server processes and reconnection policy; the library owns client
generations, editor bindings, and document synchronization.

## Boundaries

- Keep the public library in `src/`. Implementation-only helpers stay out of its
  top-level export. The `/codemirror` entry passes through official upstream APIs.
- Keep React and `@leanprover/infoview` outside the core entry's dependency graph.
- `@codemirror/lsp-client` is pinned because workspace mapping uses guarded
  internal registries. An upgrade must exercise late-loaded files and edits made
  while requests are in flight.
- The private platform packages are shared with `verso-mirror`. Keep editor and
  process-specific policy in the hosts. Use `docs/editor-platform.md` when
  changing that shared boundary.
- The `0.x` API may change without compatibility aliases. See `CONTRIBUTING.md`
  for API and changelog policy, and `docs/RELEASING.md` for publishing work.

## Completion and verification

Carry an authorized change through implementation, appropriate verification,
and a clear report of remaining limitations. Choose tests that exercise the
failure or behavior being changed; avoid repeating passed checks without a new
reason. Use `docs/DEVELOPMENT.md` for setup and the verification matrix.

Local tests use development fixtures and local processes. Browser suites reset
`demo/workspace/Main.rs` and `RustSnippets.lean`; preserve any manual edits to
those fixtures before running them. Run browser suites sequentially because
they share that workspace and fixed default ports.

Keep coherent, verified changes in small topic-branch commits. Use a separate
worktree for substantial independent topics. Preserve unrelated work and cached
toolchains; `.demo-cache` and `.codex-cache` are local infrastructure.
