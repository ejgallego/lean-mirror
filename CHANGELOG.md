# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this package follows SemVer once it reaches `1.0.0`.

## Unreleased

### Added

- Initial Lean 4 CodeMirror 6 package built on top of `@codemirror/lsp-client`
- Lean language support, browser transport helpers, host-managed workspaces, utilities, demo app, and automated tests
- Typed Lean `$/lean/fileProgress` tracking via `leanFileProgress()`, `LeanFileProgressStore`, and `LeanFileProgressKind`.
- Internal WorkDoneProgress handling for demo rust-analyzer progress without conflating it with Lean file-processing ranges.
- Additional mocked LSP and embedded editing regression coverage for hover, formatting, rename, references, progress, CRLF fenced blocks, duplicate labels, round trips, and diagnostic remapping.

### Changed

- Embedded fenced-block parsing now preserves correct UTF-16 offsets on CRLF input and gives duplicate labels stable generated keys.
