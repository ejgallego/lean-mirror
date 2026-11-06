# Enriched display: first worker-snapshot experiment

Date: 2026-11-06. Implementation:
[`experiments/snapshot-display`](../../experiments/snapshot-display/README.md).

## Outcome

Real Lean file-worker snapshots are a viable starting point for enriched display.
The prototype extracts theorem signatures, proof/value regions, documentation
and command context without a second parser or a second elaboration pass. Backend
selection is configurable per request. This establishes a source-outline path;
it does not yet establish a faithful mathematical-statement provider.

The native experiment runs on the repository's Lean 4.34.1 pin. It changes no
public TypeScript exports, shared platform APIs, demo backend or sibling sources.
The next slice should resolve declarations and their contextual statement data
before committing to a shared schema or KaTeX translation API.

## Observed evidence

The fixture contains module documentation, namespace/section variables, a
definition, three theorems including a private helper, local notation, declaration
documentation and a mutual definition command. Its saved source and the plugin
both passed Beam sync with zero errors and warnings. The native plugin build
and real LSP integration harness passed.

| Check | Observed result |
| --- | --- |
| Completed fixture | 14 snapshot commands, including header/end-of-input; 28 selected syntax regions |
| Documentation | Three declaration doc comments and one module doc region found in actual syntax |
| Statement/proof boundary | `identity_eq` exposes `: identity x = x` separately from `:= by` and its proof |
| Backend selection | All commands, theorem-containing commands, and exact written names work; a later all-policy request is unaffected by the preceding name-policy request |
| Mutual command | Selecting `even` selects the command containing both `even` and `odd` |
| Source coordinates | Every returned region reproduces the original substring with JavaScript UTF-16 slicing, including the CRLF/non-BMP variant |
| Authority | Old version and mismatched original source rejected with ContentModified |
| Invalid configuration | Unknown policy and excessive wait rejected with InvalidParams |
| Incomplete proof | Snapshot traversal completes but semantic status stays not-assessed |
| Pending analysis | A deliberately slow command yields partial, then complete on a later pull for the same revision |
| Cancellation/edit race | Explicit cancellation and an edit during a pending request produce the appropriate cancellation/content-modified errors |
| Ownership | Harness confirms no process remains in its owned process group after graceful shutdown |

Exact partial-prefix lengths depend on worker scheduling. They are not protocol
invariants. The test writes full responses to ignored `evidence.json`; the checked
in fixture and harness reproduce the checks without requiring a server to be
running beforehand. The test's JSON-RPC dispatcher separates server requests
from responses: request identifiers in opposite directions can overlap.
The cleanup check also caught an `exit` notification encoded with object
parameters; Lean expects absent/null parameters. The harness now sends the
parameterless notification and closes stdin, and fails if forced cleanup is needed.

## What this changes in the design

**Keep command structure and declaration details separate.** A mutual command has
two declarations, while generated declarations may lack independent source
ranges. Flattened syntax regions are enough to investigate source boundaries,
but not enough to assign every declaration its own expandable presentation.
Retain an enclosing source-command fallback when ownership is uncertain.

**Preserve context before translating statements.** The written signature of
`identity_eq` omits section-bound type and term parameters. The local-notation
example retains `𝓝` in syntax. A syntax-only translator would miss context;
printing only an elaborated type may lose the author's notation. The next detail
experiment must compare syntax and elaborated declaration metadata from the
same snapshot, including private and generated names.

**Use separate readiness concepts.** End of snapshot traversal does not mean all
syntax is supported, all regions have precise ownership, or proofs succeeded.
The prototype calls this `snapshotStatus`, not structural authority. A production
contract needs coverage and explicit pending/unsupported/error fallbacks, plus
independent semantic availability. Ordinary comments and whitespace also remain
in source even though this probe does not report them as separate nodes.

**Keep selection separate from reader state.** Backend policies label commands;
the returned source structure still contains omitted material. Reader expansion
should not mutate the policy. The prototype validates request-local configuration
but is not a provider registry or an implementation of relevance/dependency
selection. It does not promise stable identities across revisions.

## Reuse and provenance

The implementation directly inspects Lean 4.34.1 `Lean.Server.RequestM.readDoc`,
`FileWorker.EditableDocument.cmdSnaps`, `Snapshots.Snapshot.stx`, and
`Snapshot.runCommandElabM`. Parser kinds come from Lean's `Parser/Command.lean`
and `Parser/Term.lean`; declaration doc comments live in the `Command` namespace
despite their definition being located in `Term.lean`.

The bounded pull/captured-document/original-source approach follows the existing
Verso worker integration inspected in `../verso-mirror/Bridge/WorkerStructure.lean`
and `Bridge/Lsp.lean`, as anticipated by the
[design proposal](../enriched-display-design.md). This experiment does not import
that implementation. Verso pins Lean 4.36.0-rc1; this result does not demonstrate
cross-version internal API compatibility. No shared extraction is justified yet.

## Next slice and remaining limits

1. Add a bounded, revision-bound declaration detail query. Resolve actual
   environment names, contextual types and documentation ownership for ordinary,
   private, mutual and generated declarations. Avoid forcing unfinished info
   trees; unavailable detail must leave the source outline usable.
2. Choose one mathematical statement subset and compare its faithful Lean and
   TeX presentations with implicit parameters and local notation. Keep the full
   Lean statement accessible. Add inline documentation and source reveal in one
   CodeMirror vertical slice using that evidence.
3. Refine the minimal delivery envelope with a real Verso consumer example:
   document/session identity, per-revision update ordering, coverage, detail
   references and policy configuration. Only then consider a common package or
   availability notification API.

The probe has no subscriptions, stable declaration IDs, detail handles,
diagnostics authority, browser UI, KaTeX provider, or production transport
integration. Its command cap and wait budget do not bound syntax traversal or
response bytes. Large-file cost, cancellation latency under CPU-heavy traversal,
reopen/restart races, custom macros, structured Verso documentation and sustained
memory behavior need their own evidence before promotion into production.
