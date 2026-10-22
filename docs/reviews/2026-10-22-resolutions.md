# Review repairs — 2026-10-22

This follows the [repository audit](2026-10-22.md) at PR #6's original head
`62941d4`. The twelve confirmed findings are implemented on
`fix/review-findings-2026-10-22`, based on that feature branch. The audit remains
historical evidence; this document records resulting behavior and verification.

## Findings and repairs

| Finding | Result | Focused evidence |
| --- | --- | --- |
| R01: retired edits | Client lifetime fences asynchronous loads and each mutation; infoview actions also check host retirement/disposal | `review-lifecycle`, `lean-infoview` tests |
| R02: malformed LSP output | Framing errors close only the owning session and reap its child | `lsp-relay-limits`: malformed session beside healthy relay |
| R03: hidden retained views | Display always requests host activation, including retained views | repeated F12 in source/packed workspace scenarios; repeated infoview navigation |
| R04: late loader versions | An existing file wins after the load await, before version metadata is installed | pending loader + open/edit/close/update regression |
| R05: retired requests | Pending/queued/subsequent requests and initialization settle on retirement; owned transport reports disconnected | lifecycle tests including response-before-disconnect and queued microtasks |
| R06: observer/reentrancy | Observer errors are isolated and reported; ownership is rechecked before starting a transport | throwing observer, disposal and replacement during initialization |
| R07: renderer divergence | One pure `demo/shared/embeddedLeanDocument.mjs` generates text and mapping metadata | exact parity for labels, commas, CRLF/CR, Unicode, preamble/postamble |
| R08: stream memory | Bounded headers/bodies/directional queues, stdin drain, stdout pause, stderr truncation, exit-aware termination | slow stdin/WS, malformed/oversized/fragmented/coalesced frames, EOF, termination timers |
| R09: outside save race | Exclusive publication retains the actual displaced inode; lock journals coordinate backend instances | outside write during proposal creation, separate stores, API read/save ordering, real HTTP contracts |
| R10: umask | Explicit chmod restores existing ordinary permission bits | subprocess with umask 0077 saving a 0644 source |
| R11: URI aliases | Canonical encoded VS Code URI identity | percent escapes, spaces, hash, Unicode round trips |
| R12: zero log cap | Zero disables retention; invalid caps reject immediately | store and service runtime state/request behavior |

The lifecycle changes start at `d6a1f5b`, with direct-client hardening at
`80f6c87`, infoview fencing at `091fa3c`/`b72051c`, and wrapper teardown at
`45d8a7f`. Renderer unification is `610a10c`;
relay bounds/containment are `fb34f23` plus coalesced-frame follow-up `287b734`;
shared fixes are `f3a8218`; recoverable saves and HTTP tests are `19c1b06`.

## Contract decisions

Direct clients now support **one connection**, including failed attempts. Create
a fresh client after disconnect or use `LeanEditorSession.reconnect()`. Allowing
same-client reuse can send a previously queued upstream request on the new wire,
or let an old initialize continuation resolve the new initialization promise.
Fresh-client sessions preserve host-managed editor state and avoid both races.
The implementation uses a connection-owned transport and public workspace hooks,
without adding another dependency on upstream private request registries.

Workspace saves provide recoverability against uncoordinated editors rather than
claiming portable atomic compare-and-swap. They retain prior disk inodes, use
exclusive publication, and report conflicts while keeping dirty browser text.
External readers can observe a brief path-absence window; hardlinks are required.
Journals cover process interruption, not power-loss durability. Retained archives
need owner-managed cleanup. See [workspace-persistence.md](../workspace-persistence.md)
for the exact writer, permissions, disk-space, and recovery contract.

The shared platform stays editor-neutral. Zero log retention is the only shared
runtime semantic change; the VS Code adapter changes URI encoding. No shared
source/provenance/status schema, transport extraction, or Lean internals move.
Verso was notified through its authorized coordination thread.

## Verification

The final **complete `npm run ci` passed** at runtime/harness commit `93f9009`
on Node 24.22.0, npm 12.0.2, Rust/rust-analyzer 1.99.0, and Lean 4.34.1.
Coverage passed: **190 root tests, 48 platform tests, 11 adapter tests**, the
committed Verso contract, 15 ordinary demo browser scenarios, one minimal browser
scenario, three workspace scenarios, builds, deterministic and real-Lean package
consumers, 75-file pack verification, and all four isolated packed-browser
scenarios. Browser suites ran sequentially; the four tracked source fixtures were
clean before and after verification. The three external scenarios are skipped in
ordinary CI and were run separately below.

All **three external Anneal browser scenarios passed**, including prepared-example
switching with diagnostic recovery, automatic regeneration after a Rust edit, and
switching through all four prepared examples. This used the managed Zerocopy
`dc12610c` checkout and its generated Lean 4.28.0-rc1 workspaces; the project/demo
pin remains Lean 4.34.1. Native preparation built each example. The successful gate
reused that prepared cache. The first cold attempt built linked_list and fetched
7873 dependency artifacts but hit the ten-minute readiness limit; that run is
preserved separately, rather than counted as a pass. A full cold-start repeat was
not performed. Rust-analyzer emitted worker reload/teardown warnings and a long
indexing turn; passing browser checks are not a general native stability or
performance claim.

Real Verso consumption passed check, all **240 unit tests**, and a production
build in an isolated git-archive copy of
`08f3c5f7d2741e09df319929e22091100ff39320`. Its adjacent lean-mirror source points
to this fix worktree. The active sibling checkout was not modified or used for
build/test writes. The committed consumer contract, 48 platform tests and 11
adapter tests also passed. The shared change does not alter service synchronization
or bridge behavior, so Verso's native LSP suite was not rerun here.

Logs are local evidence rather than committed generated artifacts:
`/tmp/lean-mirror-findings-ci-final-2026-10-22.log`,
`/tmp/lean-mirror-findings-final-unit-2026-10-22.log`,
`/tmp/lean-mirror-verso-consumer-fixes-2026-10-22.log`, and
`/tmp/lean-mirror-findings-anneal-retry-2026-10-22.log`.
The initial integration and cold external attempt remain in
`/tmp/lean-mirror-findings-ci-2026-10-22.log` and
`/tmp/lean-mirror-findings-anneal-2026-10-22.log`.

The external gate also exposed a startup-polling weakness: repeated `/session`
requests during synchronous preparation can leave expensive snapshot work queued
after callers time out. The gate now polls the cheap `/status` endpoint until
ready, then reads the session. The retry reused prepared artifacts and progressed
through the remaining native examples and all browser checks. This harness repair does not change the
public library or shared platform.

## Remaining observations

The audit's early-socket-close retry timing and external cache compiler-environment
identity questions were observations, not confirmed findings. They remain separate
follow-ups. No sustained multi-hour whole-demo memory claim is made. Verso's
independent Lean 4.36-rc1 worker migration and unattributed server-manager RSS growth
remain owned by that project.
