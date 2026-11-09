# Enriched Lean document display: use cases

Working requirements, 2026-11-06. This is a central product direction for
`lean-mirror`, with a shared Lean–editor information boundary relevant to
`verso-mirror`. The companion [design exploration](enriched-display-design.md)
records candidate mechanisms and questions to resolve before implementation.

**Direction clarified (2026-11-09).** The target is a progressive shift from
source toward enriched presentation within the same document component. Main
contributions should be highlighted and filterable, initially through manual
selection. Supplied or mock mathematical content is sufficient while interaction
and rendering are designed; author metadata and automatic presentation providers
come later. A separate reading pane is not the default target.

The detailed interactions below remain proposals. The
[interaction design](enriched-display-design.md#interaction-proposal-for-review)
compares in-place and margin-to-inline presentation and specifies source reveal,
contribution focus, and pending/error states for review. Ordinary reactive Lean
editing remains the baseline. The current task is design, before implementation.

## Goal and governing constraint

Let a reader understand and navigate a Lean development as a mathematical
document, and move directly into editing its source. The same file should
support detailed source editing and a concise, enriched reading view.

Lean supplies the structural information from its actual file-worker snapshots,
through requests or subscriptions. The editor uses that information to place
and update displays. Recognition of declarations, statement boundaries, proof
bodies, and documentation must not depend on a second frontend Lean parser.
Incomplete or unsupported regions remain available as source.

The initial candidates are mathematical theorem statements rendered with
KaTeX, inline documentation, and summaries that show selected core lemmas with
dynamic expansion. These displays are projections of the source; changing the
view does not rewrite the Lean file.

## UC1: Read a theorem as mathematics

A reader opens a file and sees a theorem's name, relevant hypotheses, and
conclusion in mathematical form, with its proof initially collapsed. The reader
can reveal the Lean statement, open the proof, and navigate to a referenced
declaration. An author can reveal source and edit it in place.

For example, a theorem with explicit natural-number binders and conclusion
`a + b = b + a` might display those binders and that equation as mathematics.
This is a presentation illustration, not a promise of a general Lean-to-TeX
translation. Implicit binders, coercions, local notation, and typeclass arguments
need a documented display policy and access to the full Lean statement.

Acceptance:

- The displayed statement is associated with a declaration in the current
  worker revision, with source navigation to its statement and proof.
- Rendering preserves the supported statement's mathematical meaning and binder
  context. Any omitted formal detail can be revealed; unsupported translation
  uses Lean text rather than a plausible but unverified mathematical rewrite.
- An available parsed statement is distinguishable from a successfully checked
  declaration. Errors and admitted/incomplete proofs are not conveyed as success
  merely because the mathematical display rendered.
- Revealing source, editing a hypothesis, and undoing that edit preserve the
  source and selection. Older mathematical output never silently becomes the
  display for the new statement.
- A rendering error affects that display only; the source remains usable.

## UC2: Read documentation inline

A reader sees declaration documentation next to its theorem, and module prose
at its source location. Prose, code examples, links, and supported math appear
inline. An author reveals the original documentation source to edit it.

Acceptance:

- Lean-provided structure determines documentation ownership and source ranges.
  Adjacent text alone is insufficient to attach a comment to a declaration.
- Module documentation, declaration documentation, and arbitrary source comments
  have explicit treatment; unknown documentation forms remain readable as source.
- Rendering follows the documentation format supported by the active project.
  Plain documentation and Verso-aware content need not use the same renderer.
- Moving, deleting, or editing a declaration does not leave another declaration
  displaying its documentation. Links reveal the correct target and source.
- Toggling the display does not alter source bytes or enter the undo history.

## UC3: Read the core argument, then expand it

A reader selects a summary profile and sees the development's selected lemmas
and enough section/namespace context to navigate. Supporting declarations and
proofs remain discoverable through expandable groups. The reader expands a
lemma, its documentation, its proof, or supporting declarations as needed.

For the first UI trial, contributions are selected by hand. Expansion and
contribution membership are separate controls. Longer term, “core” is a
configurable backend policy. Supported policy families should be
able to express author annotations and reader pins, structural filters such as
public theorem declarations, and dependency/relevance-based selection. These
are distinct useful interpretations; no single ranking is built into the UI.

Acceptance:

- The active profile is identifiable, and the reader can inspect why a lemma
  was selected. A policy's configured inputs and availability are explicit.
- Hidden material has discoverable expansion controls and counts where known.
  A summary never implies that omitted declarations or assumptions do not exist.
- User expansion and pinning survive unrelated edits when identity can be
  established safely. Ambiguous correspondence does not transfer state to an
  unrelated declaration.
- Switching profiles uses the same source revision and preserves the source.
  Independent readers can use different profiles without affecting each other.
- An error in hidden material remains discoverable from the summary. Navigation,
  search, and “reveal source” open the necessary enclosing collapsed regions.
- A dependency-based profile identifies the relation it uses, such as references
  in statements or proof dependencies. Missing analysis is reported explicitly.

## UC4: Edit while analysis catches up

An author changes a theorem or its documentation while Lean is still processing
an earlier version. The editor keeps the draft interactive. It returns affected
regions to source, or marks a previous display as stale, until matching analysis
is available. Restarting Lean retires the old generation's results.

Acceptance:

- Every applied structure/detail result matches the document identity, source
  revision, and active server generation. Multiple tabs and reopened documents
  cannot share authority accidentally.
- Partial analysis declares its coverage. Missing structure is not interpreted
  as permission to erase the draft or hide the rest of the file.
- Source, diagnostics, and rendered mathematics can have different availability
  states. The UI exposes the distinctions needed to understand current feedback.
- Keyboard movement, selection, copy, search, and source editing remain usable.
  Default copy returns Lean source; copying a rendered mathematical form is a
  separately named action.
- Closing a view or superseding a request releases its subscriptions and pending
  work. Expensive detail rendering is requested only when useful to the view.

## UC5: Reuse the Lean–editor boundary for Verso

A Verso author works with document blocks and embedded Lean material. Both
editors need current source identity, structural ranges, partial coverage,
capabilities, cancellation, and invalidation. Their display trees and editing
semantics differ.

Acceptance:

- The proposed information envelope can carry a Lean declaration summary and
  a Verso block summary without embedding CodeMirror or ProseMirror objects.
- The design preserves Verso's current exact-version and original-source
  validation, UTF-16 offsets, and explicit `complete` / `partial` / `none`
  structure behavior, or documents an intentional migration with equivalent
  guarantees.
- Lean internals stay behind a version-specific backend adapter. Shared wire
  data contains compact summaries and bounded detail references.
- Shared extraction follows a working example for each consumer; this document
  does not change the sibling's protocol or source files.

## First acceptance fixture

Choose a small, real Lean file containing documented theorems, helper lemmas,
a namespace or section, local notation, implicit parameters, and a nontrivial
proof. Add variants with incomplete syntax, a failing declaration, CRLF and
non-BMP characters, and edits before the rendered declaration. Include a Verso
fixture that exercises the same identity/range/partial-result boundary.

Demonstrate: open summary; change selection profile; expand one theorem; reveal
and edit its source; observe stale-to-current feedback; undo; follow a reference
into hidden material; restart Lean; close and reopen. Acceptance records source
preservation, selection, revision correctness, resource cleanup, and observed
latency. Numeric performance budgets follow initial measurements.

## Decisions still to make

- Which real document should drive the first implementation?
- Which backend policy is the default, and how are project annotations and
  reader-specific options configured? Configurability itself is agreed.
- Which mathematical constructs have a faithful initial TeX representation?
- Which documentation formats can the active Lean toolchain export structurally?
- In the same editor, should Mixed presentation place rendered content directly
  in the source flow or in a companion margin that moves inline?
- Which explicit and caret-driven actions reveal source, and when may it collapse?
- Which live snapshot publication API is suitable upstream? Pull versus broadcast
  is an implementation choice to evaluate against the same acceptance cases.
