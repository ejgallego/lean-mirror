import { describe, expect, test } from "vitest";

import { EditorPlatformStore, EditorServiceRuntime } from "../src/index.js";

describe("EditorServiceRuntime", () => {
  test("records lifecycle events into the platform store", () => {
    let now = 100;
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(
      store,
      {
        id: "lean",
        kind: "lean-lsp",
        label: "Lean"
      },
      {
        now: () => now
      }
    );

    runtime.starting("Connecting");
    now = 125;
    runtime.initializing();
    now = 150;
    runtime.ready();

    expect(store.snapshot.services.lean?.status).toEqual({ state: "ready" });
    expect(store.snapshot.services.lean?.updatedAt).toBe(150);
    expect(store.snapshot.logs.map((event) => event.message)).toEqual([
      "Lean starting: Connecting",
      "Lean initializing",
      "Lean ready"
    ]);
  });

  test("records generic connection statuses", () => {
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(store, {
      id: "lean",
      kind: "lean-lsp",
      label: "Lean"
    });

    runtime.connecting();
    runtime.recordConnectionStatus({ phase: "failed", message: "Lean exited", recoverable: true });

    expect(store.snapshot.services.lean?.status).toEqual({
      state: "failed",
      message: "Lean exited",
      recoverable: true
    });
    expect(store.snapshot.logs.map((event) => event.message)).toEqual([
      "Lean starting: Connecting",
      "Lean failed: Lean exited"
    ]);
  });

  test("records request start and completion logs", () => {
    let now = 10;
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(
      store,
      {
        id: "verso",
        kind: "verso-parser",
        label: "Verso"
      },
      {
        now: () => now
      }
    );

    const request = runtime.beginRequest("parseDocument");
    now = 42;
    request.succeeded();

    expect(store.snapshot.logs).toHaveLength(2);
    expect(store.snapshot.logs[0]?.message).toBe("Verso request started: parseDocument");
    expect(store.snapshot.logs[1]?.message).toBe("Verso request completed: parseDocument");
    expect(store.snapshot.logs[1]?.details).toMatchObject({
      event: {
        durationMs: 32,
        requestId: "verso:1",
        type: "request-succeeded"
      }
    });
  });

  test("records request failures without changing service status", () => {
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(store, {
      id: "rust",
      kind: "rust-lsp",
      label: "Rust"
    });

    runtime.ready();
    const request = runtime.beginRequest("textDocument/diagnostic");
    request.failed(new Error("server busy"));

    expect(store.snapshot.services.rust?.status).toEqual({ state: "ready" });
    expect(store.snapshot.logs.at(-1)).toMatchObject({
      level: "error",
      message: "Rust request failed: textDocument/diagnostic: server busy"
    });
  });

  test("tracks successful promise-returning requests", async () => {
    let now = 20;
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(
      store,
      {
        id: "lean",
        kind: "lean-lsp",
        label: "Lean"
      },
      {
        now: () => now
      }
    );

    const result = await runtime.trackRequest("textDocument/hover", async () => {
      now = 45;
      return { contents: "Nat" };
    }, "hover-1");

    expect(result).toEqual({ contents: "Nat" });
    expect(store.snapshot.logs.map((event) => event.message)).toEqual([
      "Lean request started: textDocument/hover",
      "Lean request completed: textDocument/hover"
    ]);
    expect(store.snapshot.logs.at(-1)?.details).toMatchObject({
      event: {
        durationMs: 25,
        requestId: "hover-1",
        type: "request-succeeded"
      }
    });
  });

  test("tracks and rethrows request failures", async () => {
    const store = new EditorPlatformStore();
    const runtime = new EditorServiceRuntime(store, {
      id: "rust",
      kind: "rust-lsp",
      label: "Rust"
    });
    const failure = new Error("bridge unavailable");

    await expect(
      runtime.trackRequest("rust-main/update", () => Promise.reject(failure))
    ).rejects.toBe(failure);

    expect(store.snapshot.logs.at(-1)).toMatchObject({
      level: "error",
      message: "Rust request failed: rust-main/update: bridge unavailable",
      details: {
        event: {
          message: "bridge unavailable",
          type: "request-failed"
        }
      }
    });
  });
});
