# Backlog

## Real Lean server coverage

- Expand the real Lean-server test suite beyond the current smoke and built-package consumer paths.
- Decide whether formatting should come from a separate formatter integration; Lean 4.30 does not advertise document formatting, while hover, references, rename, semantic tokens, and versioned diagnostic recovery now have real-server paths.
- Prefer real workspace-style scenarios over demo-only transport tests where possible.

## Deferred Lean toolchain update

After the remaining prototype goals are complete, update the validation target to the Lean 4.33
release candidate. Align the demo workspace pin and the package-consumer test environment, then
run the complete typecheck, unit, browser, real-server, downstream-package, and tarball gates.
