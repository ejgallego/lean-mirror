# Editor Platform

`@leanprover/editor-platform` contains editor-agnostic runtime primitives for experimental Lean editing surfaces.

The package is intentionally small at this stage. It defines the status, document, diagnostic, log, and snapshot models that browser demos, VS Code custom editors, and tests can share before any CodeMirror- or ProseMirror-specific code is involved.

## Scope

This package may own:

- service lifecycle status for Lean, Rust, Verso parser, and future bridge services
- document identity and version metadata
- diagnostics and logs in a common shape
- shell/runtime snapshots that editor hosts can render
- lightweight observable state used by demos, VS Code webviews, and tests

This package must not own:

- CodeMirror extensions, workspaces, commands, or keymaps
- ProseMirror schemas, plugins, node views, or reconciliation
- Verso CST projection logic
- browser or VS Code UI components
- concrete process spawning policy until the host/service boundary is clearer

## Current API

- `EditorPlatformStore`: observable shell snapshot state for services, documents, diagnostics, and logs
- `EditorServiceRuntime`: small service lifecycle/request/log adapter around an `EditorPlatformStore`
- `createEditorPlatformShellView`: pure view model for shell status, diagnostics text, and service-light state
- `ServiceEvent`: editor-agnostic lifecycle events for starting, ready, stale, failed, and stopped services
- `ServiceConnectionStatus`, `serviceEventFromConnectionStatus`: shared mapping from host connection phases to lifecycle events
- `DocumentSnapshot`: URI, language, version, open state, and sync state for files or virtual documents
- `createDocumentSnapshot`, `documentTitleFromUri`, `inferLanguageIdFromUri`: shared document identity helpers for browser demos and editor shells
- `EditorDiagnostic`: common diagnostic shape with UTF-16 ranges
- `diagnosticsForDocument`, `groupDiagnosticsByDocument`, `summarizeDiagnosticsForDocument`: document-scoped diagnostic helpers
- `HostToEditorMessage` / `EditorToHostMessage`: typed host/webview protocol messages with no VS Code dependency
- `createHostEndpoint` / `createEditorEndpoint`: small typed adapters around `postMessage`-style transports
- `createPostMessageTarget`, `createMessageEventSource`, `createOnDidReceiveMessageSource`: structural adapters for browser and VS Code-style message APIs
- `publishPlatformSnapshots`: publishes store snapshots over the host-to-editor protocol

Example:

```ts
import { EditorPlatformStore, EditorServiceRuntime } from "@leanprover/editor-platform";

const store = new EditorPlatformStore();
const lean = new EditorServiceRuntime(store, {
  id: "lean",
  kind: "lean-lsp",
  label: "Lean"
});

lean.starting("Connecting");
const request = lean.beginRequest("textDocument/diagnostic");
request.succeeded();
lean.ready();
```

## Development Topology

For now this package lives inside `lean-mirror` and `verso-mirror` consumes it through a local file dependency:

```json
"@leanprover/editor-platform": "file:../lean-mirror/packages/editor-platform"
```

That is intentional while the shared boundary is still being validated. If the API continues to be shared cleanly, this package can later move into a parent monorepo or a dedicated package repository.

## Next Boundary

Host/editor messaging for VS Code custom editors and browser demos now has a shared typed envelope and transport adapter. Concrete VS Code extension registration, webview HTML, and process spawning should remain outside this package until the host boundary is clearer.
