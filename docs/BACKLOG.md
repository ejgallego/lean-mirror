# Backlog

## Real Lean server coverage

- Expand the real Lean-server test suite beyond the current smoke and built-package consumer paths.
- Decide whether formatting should come from a separate formatter integration; Lean 4.33.0-rc1 does not advertise document formatting, while hover, references, rename, semantic tokens, and versioned diagnostic recovery now have real-server paths.
- Prefer real workspace-style scenarios over demo-only transport tests where possible.
