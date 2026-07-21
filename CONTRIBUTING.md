# Contributing

## Experimental API policy

The top-level package export is the current Lean-specific experimentation surface:

- `createLeanLspClient`
- `createLeanEditorSession`
- `leanLspExtensions`
- `lean4`
- `leanFallbackLanguageSupport`
- `leanUtilities`
- `createLeanWorkspace`
- transport helpers and Lean-specific types

If a change only affects implementation details, keep it out of the top-level export.

Until `1.0.0`, there is no compatibility guarantee for this surface. Exports, options, and
behavior may be changed or removed without aliases, overloads, or a deprecation period. Consumers
that need reproducible experiments should pin an exact version or commit.

The `codemirror-lean4-lsp/codemirror` subpath is an explicit passthrough for official `@codemirror/lsp-client` exports. Changes there should track upstream CodeMirror behavior, not invent a wrapper policy.

## Versioning policy

- The entire `0.x` series is initial development and intentionally unstable.
- Patch releases contain focused fixes or refinements; they may still break the experimental API.
- Minor releases mark broader feature or architecture milestones; they may also break the API.
- API changes do not require compatibility aliases or a particular `0.x` version increment.
- Starting at `1.0.0`, normal SemVer compatibility rules apply and breaking changes require a major release.

## Changelog policy

- Update `CHANGELOG.md` for any user-visible change
- Add entries under `Unreleased`
- Group entries by `Added`, `Changed`, `Fixed`, `Removed` where useful

## Release checks

Before publishing, run:

```bash
npm run ci
```

`npm run ci` includes browser coverage. Run `npm run playwright:install` first on a new machine.
