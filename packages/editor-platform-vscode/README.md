# @leanprover/editor-platform-vscode

VS Code-facing host helpers for editor-platform custom editors.

This package is intentionally structural:

- it accepts objects shaped like VS Code `Webview`, `WebviewPanel`, `Uri`, and custom documents
- it does not import `vscode`
- it does not register custom editors, create webview HTML, or spawn language servers

The goal is to keep extension projects thin while leaving editor-specific UI and VS Code contribution points outside the shared platform package.

## Current API

- `createEditorPlatformCustomEditorHost`: creates a host-side endpoint for a webview and publishes platform snapshots to it
- `attachEditorPlatformHostToPanel`: attaches the host lifecycle to a panel disposal callback
- `documentOpenedMessage`: creates a shared `document-opened` protocol message from a VS Code-shaped custom document
- `vscodeUriToString`: normalizes a VS Code-shaped URI for editor-platform messages

Editor commands may include a `requestId`. The host then sends a typed `command-result` response
that distinguishes successful handling, ignored or missing handlers, and thrown failures.

Example:

```ts
import {
  documentOpenedMessage,
  createEditorPlatformCustomEditorHost
} from "@leanprover/editor-platform-vscode";
import { EditorPlatformStore } from "@leanprover/editor-platform";

const store = new EditorPlatformStore();
const host = createEditorPlatformCustomEditorHost({
  store,
  webview: panel.webview,
  handlers: {
    restartService: ({ serviceId }) => {
      // Extension-owned service restart policy stays here.
    }
  }
});

host.postMessage(documentOpenedMessage(document, { languageId: "lean", text }));
```
