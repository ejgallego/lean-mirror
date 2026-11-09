# In-place snapshot display experiment

This isolated Lean 4.34.1 experiment combines real file-worker structure with the
first in-place CodeMirror interaction slice from the
[enriched display design](../../docs/enriched-display-design.md). It is an opt-in
UI trial, outside the public library and shared platform APIs.

## Try the browser demo

Install the repository's npm dependencies, then from the repository root:

```sh
(cd experiments/snapshot-display && lake build DisplayProbe:shared)
node experiments/snapshot-display/serve.mjs
```

Open **http://127.0.0.1:5282**. Use `SNAPSHOT_DEMO_PORT` to choose another port.
The server listens only on loopback. Stop it with Ctrl-C.

1. Switch **Source → Mixed → Rendered**. Mixed puts the companion immediately
   below its source; Rendered replaces the supported declaration in the same
   editor. Original namespace, section, variable and notation lines remain.
2. Turn on **Focus contributions**. Two statements are initially marked; use
   **Mark contribution** to change membership. Supporting declarations collapse
   to visible headers and can be opened individually.
3. Use **Edit source**, move the caret, then **Return to display**. Focus lands on
   the persistent Edit source button; activating it restores the source selection.
   **Show proof with source** opens the whole declaration at its proof.
4. Click a rendered equation to select its whole Lean statement. Default Copy
   and **Copy Lean statement** exclude documentation and proof. **Copy rendered
   mathematics** copies the supplied mathematical text and context. There is no
   mathematical substring selection or inferred symbol-to-token correspondence.
5. Select across a hidden helper, or Select All in the source editor. Every
   selected interval reveals before ordinary editing, including secondary ranges.
   A deletion at a replacement boundary first reveals without changing any
   cursor's source; release and press again to edit. Presentation changes create
   no source undo entries.
6. Edit an earlier notation, or break a proof. The old presentations disappear
   immediately. Real Lean diagnostics, source underlines and hover stay active;
   **Reveal diagnostic** opens the affected source. Undo restores the fixture
   presentations when the complete original text returns.

Edits stay in the tab and never alter the fixture on disk. Each browser connection
owns a separate Lean server session (maximum four). The host reuses
`demo/server/lspProcessBridge.mjs`; the browser uses the existing lean-mirror
session, synchronization and LSP integration. Snapshot requests use that same
client and its captured document version. Reload after disconnection.

## Scope and remaining walkthroughs

- Mathematics is supplied fixture text, rendered with ordinary HTML typography.
  There is no Lean-to-TeX provider or KaTeX dependency yet. Supplied presentations
  require the entire captured editor text to match the fixture; even a proof-only
  edit withdraws them. The adapter captures CodeMirror's LF text, and all ranges
  index that exact UTF-16 string. The native endpoint also accepts raw CRLF.
- Only unambiguous, full-line declaration commands get controls. Unsupported and
  ambiguous syntax stays source. Documentation is plain text. Mutual declarations
  remain one source group. Module prose and separate proof-only disclosure are
  follow-ups; the current proof action keeps declaration context visible.
- Contribution marks and source bookmarks are in-memory preferences, matched by
  written namespace/names and mapped command bounds. Partial results retain
  pending preferences. Changed or ambiguous correspondence drops the preference
  with a notice; it never authorizes reusing mathematical presentation.
- Checking, diagnostics and supplied mathematics remain distinct. The UI says
  whether diagnostics were reported and explicitly does not infer proof validity.
  A completed structural snapshot is not a proof-success signal.
- Partial snapshots trigger at most 20 bounded pulls, then require manual refresh.
  The trial does not establish production performance or a large-file protocol.
- Transitions are discrete. Keyboard/focus paths are automated, but a real IME
  composition and actual screen-reader walkthrough remain required before calling
  the full interaction contract validated. Mathematical selection is region-level.

## Verify the interaction slice

With the server running, from the repository root:

```sh
node --test experiments/snapshot-display/test-enrichment.mjs
PLAYWRIGHT_BROWSERS_PATH=/path/to/installed/playwright-browsers \
  node experiments/snapshot-display/test-browser.mjs
```

Omit the environment variable when using Playwright's default browser location;
set `SNAPSHOT_DEMO_URL` if using another port. The browser test uses real Lean and
CodeMirror, checks full/multiple selections, clipboard scope, focus/bookmarks,
boundary deletion and held keys, cut/delete/paste/typing and undo, upstream-context
invalidation, proof errors and admitted-proof warnings, diagnostic navigation,
hover, CRLF/non-BMP editor ranges and narrow layout. It leaves the fixture unchanged
and writes ignored desktop/mobile screenshots. Transaction tests cover both
boundary directions and cancellation of an entire multiple-cursor mutation.
These opt-in tests are separate from the native checks and default CI.

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
translated to TeX, and no worker snapshot is retained beyond a request. The browser
guards request generations, captured versions and edits, and
withdraws all presentations on source changes. This is still an experiment, not
a stable declaration-ownership or mathematical-presentation protocol.

See the [findings and next slice](../../docs/reviews/2026-11-06-snapshot-display.md).
