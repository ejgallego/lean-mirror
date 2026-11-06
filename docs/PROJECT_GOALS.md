# Project goals and use cases

Working recap, 2026-11-06. This document separates existing responsibilities
from proposed priorities. It is a starting point for choosing the next product
slice, rather than a commitment to implement every candidate below.

## Purpose

Make Lean checking and Verso authoring available inside applications where
people work with code, proofs, and technical documents. The editors should give
users useful feedback while preserving their work through incomplete syntax,
slow checking, server restarts, and changes to generated artifacts.

The two editor projects address complementary tasks:

| Component | User task or responsibility | Reusable result |
| --- | --- | --- |
| `lean-mirror` | Edit Lean source inside a browser application, including projects with several files | Lean support for CodeMirror, client generations, document synchronization, navigation, edits, and an optional official infoview |
| `verso-mirror` | Edit a Verso document through structured authoring while retaining its Lean source | Verso-specific projection, editing, source preservation, and Lean-backed analysis |
| Private `editor-platform` packages | Present document/service state, diagnostics and logs, and exchange host commands | Small support APIs shared by the two editors |
| `vscode-lean4` / official infoview | Supply upstream editor integration and the infoview components reused by `lean-mirror` | An upstream integration boundary; a separate VS Code host for these editors remains a possible application |

`verso-mirror` currently consumes the shared platform package. It does not
currently embed the `lean-mirror` CodeMirror editor. Embedding a Lean editor in
a Verso code block is a possible future use case that would need its own design
and acceptance criteria.

## Workflows that should drive development

### Browser Lean editing

A host application mounts a Lean editor and optionally an infoview, connects
to the project's Lean server, and provides loading and persistence. A user edits
a proof, sees goals and diagnostics, follows definitions into another file,
and saves their work. Reconnecting Lean preserves the draft, selection, and
undo history. Closing the editor retires its owned requests and resources.

The [minimal example](../examples/minimal/README.md) demonstrates the package
integration. The [workspace example](../examples/workspace/README.md) exercises
navigation, per-file state, saving, and recovery. The isolated packed consumer
checks that applications can use the built package without repository aliases.
These examples are development compositions, not a hosted editor service.

### Proofs alongside another source language

A user works with Rust source and related Lean snippets or generated Lean
artifacts. Editing or regenerating the Rust side changes the relevant checking
context. The host makes freshness and generation failures visible and prevents
results for old artifacts from appearing current.

The full demo and external Anneal scenarios exercise this workflow. Extraction,
generation, artifact caching, and process policy belong in that host. They do
not become requirements for a minimal Lean editor installation.

### Structured Verso authoring

An author edits prose, headings, lists, code, roles, and directives within a
`#doc` body. The structured surface preserves the surrounding Lean source and
retains source that it cannot yet represent structurally. Incomplete input
remains editable while Lean is unavailable or working on an older revision.

Lean and Verso determine parsing and extension semantics. The frontend handles
interaction, projection, reconciliation, and explicit fallback. Analysis must
match the source revision it describes. Structure availability, diagnostics,
and semantic validity remain distinct concerns.

The sibling's [README](../../verso-mirror/README.md) and
[LSP contract](../../verso-mirror/docs/LSP.md) describe its current scope and
worker-backed analysis. Those relative paths assume sibling checkouts; see
the [dependency model](editor-platform.md). The sibling backlog includes
historical milestones and should be reconciled against current implementation
before treating an unchecked item as new work.

### Optional host integration

VS Code may host one of these authoring surfaces when that serves a concrete
workflow, such as a structured Verso document or an embedded proof view. Its
document ownership, save/undo integration, extension registration, and process
policy belong in the host integration.

The existing private VS Code adapter supplies message and lifetime helpers.
It is not a runnable extension. A webview-panel experiment can validate the
message boundary; a complete custom editor also needs document and persistence
integration. Building that extension is not a prerequisite for the browser
use cases above.

## Boundaries to retain

- Lean and Verso own language semantics. A frontend bootstrap parser supports
  editing and fallback without becoming a second authoritative implementation.
- Host applications own processes, reconnection policy, persistence, and any
  generation pipeline. `lean-mirror` owns client generations, editor bindings,
  and document synchronization.
- The core `lean-mirror` entry stays independent of React and the infoview.
  Hosts opt into the official infoview through its separate entry.
- Shared platform APIs cover common state and messages. Editor-specific models,
  Lean worker internals, and process policy remain local. Another extraction
  needs two real consumers with the same requirement.
- Source identity and revision checks govern whether a result is applicable.
  Connection readiness alone does not establish completed or successful checking.
- Unsupported structure and degraded services remain visible without replacing
  the user's draft with a lossy representation.

Detailed package boundaries remain in [editor-platform-boundary.md](editor-platform-boundary.md)
and [AGENTS.md](../AGENTS.md). This recap does not introduce a shared runtime,
shared parser, new transport, or a general-purpose IDE framework.

## Proposed next slices

1. **Complete the actual infoview lifetime integration.** Work on the assumption
   that upstream ownership/disposal support will land shortly. The local adapter
   already detects `mountInfoview()` when available; its owning path currently
   has mock coverage and the installed renderer uses the documented fallback.
   Test an actual candidate or released upstream build before raising the
   dependency floor or removing compatibility code. Acceptance: mount, operate,
   dispose, and remount through public package entries; React effect cleanups run;
   owned requests and timers retire; the production bundle uses the owning API.
   The exact upstream release and availability remain assumptions to verify.
2. **Choose and improve one real authoring session.** Use a real document or
   consumer beyond the small demonstration fixtures. A candidate Lean scenario
   is a multi-file proof edit with infoview actions, a save, a server restart,
   and reopening the saved result. A candidate Verso scenario is an edit to prose
   and a structured directive, an incomplete intermediate form, and byte-for-byte
   preservation of untouched source after analysis catches up. Record
   friction before adding general abstractions. Acceptance should cover source
   preservation, selection/undo, current diagnostics, and understandable status.
   Verso implementation changes are coordinated in its repository.
3. **Keep maintenance bounded.** Triage the inherited development dependency
   audit findings by the affected execution path, update dependencies with
   relevant verification, and reconcile stale backlog entries. Broader extraction
   or a VS Code application follows a demonstrated workflow requirement.

These slices are ordered proposals. A concrete goal should name its user,
document or project, editing sequence, and observable completion criteria.
No frontend editing-model replacement or new host is implied by this recap.

## Discussion with the vscode-lean4 maintainer

The immediate upstream request is a supported infoview lifetime boundary that
browser hosts can consume. Useful points to settle with Marc are:

- the mount handle and disposal contract, including repeated disposal and widget
  effect cleanup;
- notification, RPC, and cancellation responsibilities during server restart;
- how to consume and test the upstream change before and after its release;
- which integration assumptions should remain in the host, and whether an
  eventual VS Code workflow provides enough user value to justify its plumbing.

The assumed upcoming landing enables integration work; it does not establish
that a specific package version is already available or that a VS Code extension
for these projects has been agreed upon.
