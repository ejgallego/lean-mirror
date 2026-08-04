# Backlog

## Real Lean server coverage

- Expand real Lean-server coverage beyond the current single-file and multi-file workspace experiments when a concrete host workflow exposes a new risk. Current real-server paths cover hover, references, rename, rendered semantic tokens, file progress, versioned diagnostic recovery, cross-file close/unload/reopen behavior, and an isolated packed browser consumer with infoview reconnection.
- Prefer real workspace-style scenarios over demo-only transport tests where possible.

## Server-to-client requests

- Defer a generic `workspace/applyEdit` request router until Lean or another supported server emits it in a concrete host workflow; the infoview now calls the core edit helper directly.
- Revisit `client/registerCapability` when a host can honor Lean's requested `.lean` and `.ilean` filesystem watchers. The demo already emits targeted `workspace/didChangeWatchedFiles` notifications for artifacts it regenerates itself.

## Shared editor platform

- Keep the current boundary fixed until both `lean-mirror` and `verso-mirror` demonstrate another identical requirement.
- Keep the committed Verso contract fixture synchronized with real `verso-mirror` usage, and run the full sibling-workspace check before extracting or publishing the private platform packages.
