import {
  EditorPlatformStore,
  serviceEventFromConnectionStatus,
  serviceIsUsable,
  serviceStatusFromEvent,
  serviceStatusLabel,
  summarizeDiagnostics
} from "../src/index.js";
import { describe, expect, test } from "vitest";

describe("EditorPlatformStore", () => {
  test("tracks service status updates", () => {
    const store = new EditorPlatformStore();
    const snapshots: string[] = [];

    store.subscribe((snapshot) => {
      snapshots.push(snapshot.services.lean?.status.state ?? "missing");
    });

    const lean = {
      id: "lean",
      kind: "lean-lsp",
      label: "Lean"
    } as const;

    store.recordServiceEvent(lean, { type: "starting", serviceId: "lean", timestamp: 10 });
    store.recordServiceEvent(lean, { type: "ready", serviceId: "lean", timestamp: 20 });

    expect(snapshots).toEqual(["starting", "ready"]);
    expect(store.snapshot.services.lean?.updatedAt).toBe(20);
  });

  test("stores documents, diagnostics, and bounded logs", () => {
    const store = new EditorPlatformStore();

    store.setDocument({
      uri: "file:///workspace/Main.lean",
      languageId: "lean4",
      version: 3,
      openState: "open",
      syncState: "clean"
    });
    store.setActiveDocument("file:///workspace/Main.lean");

    store.setDocumentDiagnostics("file:///workspace/Main.lean", [
      {
        severity: "error",
        message: "unknown identifier"
      },
      {
        severity: "warning",
        message: "unused variable"
      }
    ]);

    store.appendLog({ level: "info", message: "first", timestamp: 1 }, { maxEntries: 2 });
    store.appendLog({ level: "warn", message: "second", timestamp: 2 }, { maxEntries: 2 });
    store.appendLog({ level: "error", message: "third", timestamp: 3 }, { maxEntries: 2 });

    expect(store.snapshot.documents["file:///workspace/Main.lean"]?.version).toBe(3);
    expect(store.snapshot.activeDocumentUri).toBe("file:///workspace/Main.lean");
    expect(summarizeDiagnostics(store.snapshot.diagnostics)).toEqual({
      errors: 1,
      warnings: 1,
      infos: 0,
      hints: 0
    });
    expect(store.snapshot.logs.map((event) => event.message)).toEqual(["second", "third"]);
  });
});

describe("service helpers", () => {
  test("labels and classifies service states", () => {
    expect(serviceIsUsable({ state: "ready" })).toBe(true);
    expect(serviceIsUsable({ state: "failed", message: "crashed" })).toBe(false);
    expect(serviceStatusLabel({ state: "starting" })).toBe("Starting");
    expect(serviceStatusLabel({ state: "initializing" })).toBe("Initializing");
    expect(serviceStatusLabel({ state: "failed", message: "Lean exited" })).toBe("Lean exited");
  });

  test("maps connection status snapshots to lifecycle events", () => {
    expect(serviceEventFromConnectionStatus("lean", { phase: "connecting" })).toEqual({
      type: "starting",
      serviceId: "lean",
      message: "Connecting"
    });
    expect(serviceStatusFromEvent({ type: "initializing", serviceId: "lean" })).toEqual({
      state: "initializing"
    });
    expect(
      serviceEventFromConnectionStatus("lean", {
        phase: "failed",
        message: "Lean exited",
        recoverable: true
      })
    ).toEqual({
      type: "failed",
      serviceId: "lean",
      message: "Lean exited",
      recoverable: true
    });
  });
});
