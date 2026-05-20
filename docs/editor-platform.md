# Editor Platform Dependency Model

`@leanprover/editor-platform` is the shared package for infrastructure that is useful before an editor implementation becomes CodeMirror- or ProseMirror-specific. Today it lives in this repository at `packages/editor-platform`.

## Current Topology

- `lean-mirror` is the source of truth for `@leanprover/editor-platform`.
- The local package is consumed in this repo through the workspace dependency `file:packages/editor-platform`.
- `verso-mirror` consumes the same package through `file:../lean-mirror/packages/editor-platform`.
- During development, `verso-mirror` also points TypeScript and Vite at `../lean-mirror/packages/editor-platform/src/index.ts`, so changes are exercised directly from source.

This keeps iteration cheap while the boundary is still moving. It does not require publishing a package for every shared edit.

## Update Flow

When changing `editor-platform` for `lean-mirror`:

1. Keep the API editor-agnostic: service status, document identity, diagnostics, logs, host messages, pure view models, and structural shell slots belong here.
2. Keep editor implementation details outside the package: CodeMirror extensions, ProseMirror schema/plugins, concrete VS Code registration, process spawning policy, and Verso CST projection stay in their host repos.
3. Run the platform checks in this repo:

```bash
npm run check:platform
npm run test:platform
npm run build:platform
```

4. Run the affected Lean editor checks:

```bash
npm run check
npm test
npm run build
```

5. From `../verso-mirror`, run the consumer checks that cover the changed API:

```bash
npm run check
npm test
npm run build
```

Run `npm run test:lsp` in `verso-mirror` when shared changes touch service status, document synchronization, diagnostics, or bridge-facing behavior.

## Why Not Split Yet?

A dedicated `editor-platform` repository or a parent monorepo may make sense once the package boundary settles. Keeping the package here for now gives us clean TypeScript package boundaries without adding release choreography before we know which abstractions are stable.

See [editor-platform-boundary.md](./editor-platform-boundary.md) for the current API boundary and extraction backlog.
