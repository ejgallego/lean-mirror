# Backlog

Use the [project goals and use cases](PROJECT_GOALS.md) to choose a concrete
authoring workflow before expanding infrastructure. Its next slices are
proposals; the items below record existing implementation follow-ups.

## Enriched document display

The [use cases](enriched-display-use-cases.md) make enriched display a central
product direction. Follow the [design sequence](enriched-display-design.md):

- The [first native worker probe](reviews/2026-11-06-snapshot-display.md) verifies
  syntax boundaries, request-local policies, original-source ranges and partial
  analysis on a Lean declaration fixture.
- Resolve declaration ownership and contextual statement details, including
  private/generated names and mutual commands; add a real Verso consumer fixture.
- Design a versioned information contract and configurable backend summary policies.
- Build one enriched display slice with source reveal and dynamic expansion;
  verify faithful rendering, current revisions, source preservation and recovery.

Infoview ownership integration can proceed in parallel when an upstream build
is available. A VS Code host is optional for these workflows.

## Real Lean server coverage

- Expand real Lean-server coverage beyond the current single-file and multi-file workspace experiments when a concrete host workflow exposes a new risk. Current real-server paths cover hover, references, rename, rendered semantic tokens, file progress, versioned diagnostic recovery, cross-file close/unload/reopen behavior, and an isolated packed browser consumer with infoview reconnection.
- Prefer real workspace-style scenarios over demo-only transport tests where possible.

## Server-to-client requests

- Defer a generic `workspace/applyEdit` request router until Lean or another supported server emits it in a concrete host workflow; the infoview now calls the core edit helper directly.
- Revisit `client/registerCapability` when a host can honor Lean's requested `.lean` and `.ilean` filesystem watchers. The demo already emits targeted `workspace/didChangeWatchedFiles` notifications for artifacts it regenerates itself.

## Shared editor platform

- Keep the current boundary fixed until both `lean-mirror` and `verso-mirror` demonstrate another identical requirement.
- Keep the committed Verso contract fixture synchronized with real `verso-mirror` usage, and run the full sibling-workspace check before extracting or publishing the private platform packages.
