# Contributing

## Public API policy

The top-level package export is the stable Lean-specific API:

- `createLeanLspClient`
- `leanLspExtensions`
- `lean4`
- `leanLanguageSupport`
- `leanUtilities`
- `createLeanWorkspace`
- transport helpers and Lean-specific types

If a change only affects implementation details, keep it out of the top-level export.

The `codemirror-lean4-lsp/codemirror` subpath is an explicit passthrough for official `@codemirror/lsp-client` exports. Changes there should track upstream CodeMirror behavior, not invent a wrapper policy.

## Versioning policy

- Patch: bug fixes, packaging fixes, non-breaking test/demo/tooling changes
- Minor: new backward-compatible Lean helpers, utilities, workspace features, or subpath exports
- Major: top-level export changes, behavior changes in stable helpers, or removed options

## Changelog policy

- Update `CHANGELOG.md` for any user-visible change
- Add entries under `Unreleased`
- Group entries by `Added`, `Changed`, `Fixed`, `Removed` where useful

## Release checks

Before publishing, run:

```bash
npm run check
npm test
npm run build
npm run pack:check
```

If browser coverage is available in the environment, also run:

```bash
npm run playwright:install
npm run test:e2e
```
