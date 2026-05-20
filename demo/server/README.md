# Demo Backend

The demo backend is intentionally split by ownership:

- `../server.mjs` owns HTTP routes, WebSocket upgrade routing, and the choice of which process to spawn for each LSP endpoint.
- `demoWorkspace.mjs` owns demo filesystem state: workspace paths, session metadata, document reads, Rust block workspaces, generated Lean snippets, update queues, and startup artifact checks.
- `lspProcessBridge.mjs` owns generic stdio LSP bridging: Content-Length frame parsing, browser WebSocket forwarding, cancel-request normalization, stderr filtering, and graceful shutdown.
- `../shared/demoProtocol.mjs` owns HTTP API endpoints, payload shapes, and runtime validators used by both the browser client and Node backend.

Keep CodeMirror/browser UI code in `demo/src/`. Keep reusable package code in `src/` or `packages/`. The backend modules here should stay Node-only and demo-specific.

## Change Guidance

- Add or change HTTP endpoints in `../server.mjs`.
- Add or change HTTP payload contracts in `../shared/demoProtocol.mjs`.
- Add file/session/update behavior in `demoWorkspace.mjs`.
- Add transport framing or process teardown behavior in `lspProcessBridge.mjs`.
- Avoid putting Lean, Rust, or filesystem policy into `lspProcessBridge.mjs`; it should not know which language server it is attached to.
- Avoid putting WebSocket frame piping into `demoWorkspace.mjs`; it should not know how clients connect.

## Checks

For workspace/session changes:

```bash
npm test -- test/demo-workspace.test.ts
npm run check
npm run test:e2e
```

For LSP bridge changes:

```bash
npm test -- test/lsp-process-bridge.test.ts
npm run check
npm run test:e2e
```

For route-level changes in `../server.mjs`, run the focused test for the touched module when applicable, then `npm run test:e2e`.
