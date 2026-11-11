# Demo document and persistence controllers

These controllers are demo-local CodeMirror host code. They do not expand the
public Lean library or the editor-platform package.

## Ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| `DemoDocuments` | Retained editor states, authored revisions, immutable source snapshots | Views, network connections, disk writes |
| `SourcePersistence` | Debounce cancellation, save ordering, request sequences, acknowledged disk revisions | Editor mutations, UI status, generator implementation |
| `ConnectionScope` | One connection generation and its acquisition/cleanup obligations | Document contents and save policy |
| Demo runtime | Mounting views, workflow capabilities, infoview, and presentation of outcomes | Independent copies of persistence counters or cached text |

## Document snapshots

The active view supplies current contents; retained states preserve selection and
undo when another file is displayed. The first update listener records each
transaction before workflow listeners schedule work. Workspace changes to hidden
files update their retained states through the same model.

An `AuthoredSnapshot` contains a URI, authored revision, and immutable text.
Authored revisions advance on document transactions, including edits that restore
an earlier string. Selection and connection reconfiguration do not advance them.
Readers use `snapshot()`; callbacks use `isCurrent()` at delivery time. Activation
retains the old state before destroying the old view and creates no new authority
for text. Opening the active file remains a no-op.

## Source receipts and derived work

A save has three distinct identities: the authored snapshot, the client's request
sequence, and the expected/acknowledged disk revision. `SourcePersistence` assigns
request sequences and serializes requests. Every successful commit advances its
known disk revision, even if the author has edited again. A stale queued snapshot
is skipped; a canceled debounce settles its caller without a write.

`currentAtCommit` is an observation, not a promise about later UI delivery.
Presentation code rechecks the document model before marking a source clean.
Returning to the original text still creates a new authored snapshot and can
require another save when an earlier request has committed different text.

`withSavedSnapshot()` obtains a fresh source receipt before running derived work
inside the serialized workflow. A generator exception cannot erase that receipt
or poison the queue. Later saves use the acknowledged revision. Disposal cancels
scheduled/queued work; it does not undo an already committed save or running
external generator. UI callbacks check disposal and snapshot identity separately.

## Workflow meanings

| Workflow | Authored text | Persistence | Derived outcome |
| --- | --- | --- | --- |
| Static Rust-in-Lean example | Lean buffer, including Rust docstring | In memory | Rust analysis; Lean definition is paired by hand |
| Lean-in-Rust example | Rust buffer, including Lean comments | Revision-checked Rust save | Disposable extracted Lean snippets; projection failure is separate from source commitment |
| External Anneal example | External Rust buffer | Revision-checked Rust save | Generation from an acknowledged snapshot; failure leaves source saved and newer edits intact |

The runtime presents these differences. The controllers do not infer workflow
capabilities from filenames or implement regeneration policy.

## Verification

`test/demo-controllers.test.ts` checks active/retained contents, undo retention,
ABA edits, hidden workspace updates, ordered receipts, failed generation, and
canceled/disposed work without starting a server. Demo browser tests exercise the
same transitions through the real views, language servers, and backend.
