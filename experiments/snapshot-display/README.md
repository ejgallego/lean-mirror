# Snapshot display feasibility probe

This isolated Lean 4.34.1 experiment extracts display information from the real
file worker. It implements the first backend experiment in the
[enriched display design](../../docs/enriched-display-design.md); it is not a
public library API. An optional browser demo presents the extracted source
statements and documentation alongside an editable CodeMirror document.

## Browser demo

Install the repository's npm dependencies if needed, then from the repository root:

```sh
(cd experiments/snapshot-display && lake build DisplayProbe:shared)
node experiments/snapshot-display/serve.mjs
```

Open **http://127.0.0.1:5281**. Use `SNAPSHOT_DEMO_PORT` to choose another port.
The server listens only on loopback. Stop it with Ctrl-C.

- Switch between theorems, all commands, or comma-separated written names.
- Expand source/proof details or locate a command in the source editor.
- Expand the other commands without changing the backend selection policy.
- Edit or undo in the source editor; the outline is invalidated immediately and
  refreshed from the worker for the new revision. Edits are in memory only.

Each browser connection owns a separate Lean server session (maximum four).
The host reuses `demo/server/lspProcessBridge.mjs` for framing, bounded queues and
shutdown. The small browser protocol client is experiment-local; it is not a new
shared transport. Reload after a disconnection to create a fresh session.

Statements remain original Lean syntax; contextual parameters, proof validity,
KaTeX translation and structured documentation rendering are not implemented.
Documentation is displayed as text. Selection remains at command granularity.
Partial snapshots trigger at most 20 bounded pulls, then require manual refresh.
Reader expansion resets when a new summary arrives.

With the server running, verify browser behavior from the repository root:

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/installed/playwright-browsers \
  node experiments/snapshot-display/test-browser.mjs
```

Omit the environment variable when using Playwright's default browser location.
The test checks real worker output, selection policies, expansion, source
navigation, edits/undo, narrow-screen overflow and preservation of the on-disk
fixture. It writes ignored desktop/mobile screenshots. This test is separate
from the native protocol checks below and is not part of default CI.

## Run

With the pinned Lean toolchain available through Elan and Node 20.19 or later:

```sh
cd experiments/snapshot-display
lake build DisplayProbe:shared
node test.mjs
```

The integration harness requires POSIX process groups. It was verified on Linux;
the macOS library path is included but untested. No npm dependencies are needed.
It opens `Fixture.lean` in memory, sends subsequent edits through LSP, and leaves
the fixture on disk unchanged. It owns and shuts down its server process group.
Generated `evidence.json` contains responses for inspection and is ignored by Git.
This experiment is opt-in and is not part of the repository's normal CI matrix.

For Lean development, use a Beam session rooted in this directory, sync the
edited modules, then stop the owner and confirm cleanup before the native build.
The Node test exercises this experiment's actual endpoint, independently of Beam.

## Experimental request

The native plugin registers `$/leanMirror/displayProbe`. All fields are required:

```json
{
  "textDocument": { "uri": "file:///absolute/path/Fixture.lean", "version": 1 },
  "source": "the exact original editor text",
  "waitMs": 1000,
  "policy": "names",
  "names": ["identity_eq"]
}
```

The captured document must have exactly that version, and `source.crlfToLf` must
equal the worker's source. Otherwise the request fails with LSP ContentModified
(`-32801`). Cancellation uses RequestCancelled (`-32800`). Unsupported policies
and waits above 1000 ms fail with InvalidParams (`-32602`).

Policies are request-local and operate on whole commands:

| Policy | Selected commands |
| --- | --- |
| `all` | Every available command |
| `theorems` | Commands containing a recognized theorem syntax node |
| `names` | Commands containing an exact written `declId` in `names` |

The response retains unselected commands so selection does not erase expansion
possibilities. Written identifiers are syntax, not resolved global names; a
universe annotation can be part of the spelling. Annotation, dependency and
relevance policies are future providers, not implemented by this probe.

## Response interpretation

- `version` identifies the captured revision within the current open document.
- `rangeBase: "file"` and `positionEncoding: "utf16"` apply to half-open
  `range.start`/`range.stop` offsets in the original source, including CRLF.
- `commands` contains actual snapshot command kinds, ranges, selected syntax
  regions, and policy selection/reasons. Regions include declaration identifiers,
  signatures, values/proofs, and documentation. They overlap and are flattened;
  they are not an editable tree or a declaration-ownership graph.
- `namespaceName` is the namespace **after** the command, read from its command
  state. It is contextual evidence, not a complete section/local-notation scope.
- `snapshotStatus: "complete"` means traversal reached the end of the captured
  snapshot stream. `partial` means a pending snapshot, failed task, or command
  limit prevented that. These reasons are deliberately not distinguished yet.
- `semanticStatus: "not-assessed"` always applies. A completed snapshot stream
  can contain an unfinished or failing proof. No proof validity is inferred.

This implementation waits only on pending snapshot tasks, checks cancellation,
caps that wait at the requested budget, and stops after 2000 commands. These are
experiment bounds, **not** a total CPU, payload, memory or latency guarantee.
Full source text, overlapping text regions and prefix-based offset conversion
are intentionally simple and unsuitable as the final large-file protocol.

No `infoTree` is forced, no helper process replays commands, no statement is
translated to TeX, and no worker snapshot is retained beyond a request. The
client would still need open-session/server-generation checks, result ordering,
coverage/fallback handling and stale-display invalidation before using this
information as an authoritative UI projection.

See the [findings and next slice](../../docs/reviews/2026-11-06-snapshot-display.md).
