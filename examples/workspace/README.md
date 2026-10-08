# Multi-file Lean workspace

Run `npm run example:workspace`, then open `http://127.0.0.1:5274`.
The host displays the local demo's Main.lean and Helper.lean, follows cross-file
definitions, retains a separate editor and undo history for each file, and
automatically reconnects after a Lean transport failure. Reconnection retries
three times; the Reconnect Lean button can retry after the backend returns.

Save all explicitly persists changed files. Disk revisions are content hashes:
another browser or disk edit produces a conflict instead of an overwrite.
Changes made while a save is in flight remain dirty. Saves are independent per
file; a failed save leaves remaining files dirty. Reloading the page loads the
saved versions and discards unsaved buffers, so save before leaving.

`publicLeanWorkspace.ts` composes CodeMirror, the session, workspace, and official
infoview using only published package entries. The shell supplies loading and
persistence callbacks. The example is repository infrastructure, outside the npm
tarball; an embedding app can copy the composition at an exact package version.
Provide trusted `sanitizeHTML` when integrating untrusted LSP Markdown.

The local backend exposes GET/POST `/lean-document` for these two files only.
Generated Lean, external Anneal files, and arbitrary filesystem paths are not
writable through this endpoint. Source saves do not run Lake builds; changes to
imported library exports may require `lake build` in the workspace before their
importers see new compiled artifacts.

Both `lean` and `lake` must be on PATH. Override `WORKSPACE_BACKEND_PORT` and
`WORKSPACE_FRONTEND_PORT` to run alongside another host. The launcher uses the
Lean-only mode of the demo backend and does not require rust-analyzer.

Verification:

```bash
npm run test:e2e:workspace
npm run build:example:workspace
npm run test:packed:browser
```

The packed-browser gate copies this exact public composition and shell into an
isolated app and runs the same workspace scenarios from production bundles.
Browser launchers restore all four demo source fixtures before and after suites.
Preserve manual demo edits first and run suites sequentially.
