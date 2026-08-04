# Releasing

## Preconditions

- `CHANGELOG.md` updated under `Unreleased`
- Version bump decided according to `CONTRIBUTING.md`
- Working tree clean

## Verification

Run:

```bash
npm run ci
```

On a new machine, run `npm run playwright:install` before the verification command.

## Package checks

`npm run pack:check` verifies that the tarball only contains publishable files
and that the export map points at files that actually exist in `dist/`.

`npm run test:packed` creates the real tarball, installs it into an isolated
temporary project, and first verifies that the core entry works without
installing the optional infoview peers. It then installs those peers,
type-checks an infoview consumer, imports the browser entry, and verifies the
packaged stylesheet and font. The temporary installation disables dependency
install scripts.

`npm run test:packed:browser` extends that gate with the optional browser peers,
the repository's public-only editor composition, and Vite. It type-checks and
production-bundles the isolated app without source aliases, then serves the
built assets against a real `lean --server` backend and reuses the minimal
startup, diagnostics, infoview, editing, and reconnect smoke. This browser form
is included in `npm run ci`; the lighter `test:packed` remains suitable for the
publish preflight.

## Publish

Publishing is performed from `https://github.com/ejgallego/lean-mirror`. Publish only from a
clean, taggable commit whose package version and changelog agree. After verification, create the
matching `v<version>` tag and publish the package with its public access setting.
