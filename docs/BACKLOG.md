# Backlog

## CodeMirror integration

- Exercise real cross-file definition, rename, workspace-edit, synchronization, and closure behavior.

## Real Lean server coverage

- Expand the real Lean-server test suite beyond the current smoke and built-package consumer paths.
- Decide whether formatting should come from a separate formatter integration; Lean 4.33.0-rc1 does not advertise document formatting, while hover, references, rename, rendered semantic tokens, and versioned diagnostic recovery now have real-server paths.
- Prefer real workspace-style scenarios over demo-only transport tests where possible.

## Lean infoview

- Move the reusable Lean RPC, navigation, editing, and cursor bridge out of the demo into an optional module that keeps the core React-free.
- Replace client notification interception with a lifecycle-aware extension boundary.

## Shared editor platform

- Keep the current boundary fixed until both `lean-mirror` and `verso-mirror` demonstrate another identical requirement.
- Automate the second-consumer contract check before extracting or publishing the private platform packages.
