# Releasing

## Preconditions

- `CHANGELOG.md` updated under `Unreleased`
- Version bump decided according to `CONTRIBUTING.md`
- Working tree clean

## Verification

Run:

```bash
npm run check
npm test
npm run build
npm run pack:check
```

If the environment supports it, also run:

```bash
npm run playwright:install
npm run test:e2e
```

## Package checks

`npm run pack:check` verifies that the tarball only contains publishable files and that the export map points at files that actually exist in `dist/`.

## Publish

When the repository remote is decided, publishing should be done from a clean taggable commit after updating the package metadata with the final repository URLs.
