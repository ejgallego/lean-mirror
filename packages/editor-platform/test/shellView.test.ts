import { describe, expect, test } from "vitest";

import {
  createEditorPlatformShellView,
  diagnosticsSummaryText,
  serviceLightState,
  type EditorPlatformSnapshot
} from "../src/index.js";

function snapshot(services: EditorPlatformSnapshot["services"]): EditorPlatformSnapshot {
  return {
    services,
    documents: {},
    diagnostics: [],
    logs: []
  };
}

describe("editor platform shell view", () => {
  test("summarizes diagnostics for compact status rendering", () => {
    expect(
      diagnosticsSummaryText({
        errors: 1,
        warnings: 0,
        infos: 2,
        hints: 1
      })
    ).toBe("1 error, 0 warnings, 2 info, 1 hint");
  });

  test("maps service status to light states", () => {
    expect(serviceLightState({ state: "ready" })).toBe("ready");
    expect(serviceLightState({ state: "initializing" })).toBe("pending");
    expect(serviceLightState({ state: "stale" })).toBe("stale");
    expect(serviceLightState({ state: "failed", message: "crashed" })).toBe("failed");
    expect(serviceLightState({ state: "stopped" })).toBe("stopped");
  });

  test("builds a shell view with host service excluded from visible services", () => {
    const view = createEditorPlatformShellView(
      {
        ...snapshot({
          host: {
            id: "host",
            kind: "demo-host",
            label: "Demo",
            status: { state: "ready" },
            documents: [],
            updatedAt: 1
          },
          lean: {
            id: "lean",
            kind: "lean-lsp",
            label: "Lean",
            status: { state: "ready" },
            documents: [],
            updatedAt: 2
          }
        }),
        activeDocumentUri: "file:///Main.lean",
        diagnostics: [
          { uri: "file:///Main.lean", severity: "error", message: "unknown" },
          { uri: "file:///Main.lean", severity: "hint", message: "try this" }
        ]
      },
      { hostServiceId: "host" }
    );

    expect(view.statusText).toBe("Ready");
    expect(view.activeDocumentUri).toBe("file:///Main.lean");
    expect(view.diagnosticsText).toBe("1 error, 0 warnings, 1 hint");
    expect(view.activeDocumentDiagnosticsText).toBe("1 error, 0 warnings, 1 hint");
    expect(view.services).toEqual([
      {
        id: "lean",
        kind: "lean-lsp",
        label: "Lean",
        lightState: "ready",
        state: "ready",
        statusLabel: "Ready"
      }
    ]);
  });

  test("summarizes active document diagnostics separately from global diagnostics", () => {
    const view = createEditorPlatformShellView({
      ...snapshot({}),
      activeDocumentUri: "file:///Main.lean",
      diagnostics: [
        { uri: "file:///Main.lean", severity: "error", message: "unknown" },
        { uri: "file:///Helper.lean", severity: "warning", message: "unused" },
        { severity: "info", message: "service note" }
      ]
    });

    expect(view.diagnosticsText).toBe("1 error, 1 warning, 1 info");
    expect(view.activeDocumentDiagnostics).toEqual([
      { uri: "file:///Main.lean", severity: "error", message: "unknown" }
    ]);
    expect(view.activeDocumentDiagnosticsText).toBe("1 error, 0 warnings");
  });

  test("prioritizes failed, pending, and stale service status over ready host status", () => {
    expect(
      createEditorPlatformShellView(
        snapshot({
          host: {
            id: "host",
            kind: "demo-host",
            label: "Demo",
            status: { state: "ready" },
            documents: [],
            updatedAt: 1
          },
          lean: {
            id: "lean",
            kind: "lean-lsp",
            label: "Lean",
            status: { state: "failed", message: "Lean exited" },
            documents: [],
            updatedAt: 2
          }
        }),
        { hostServiceId: "host" }
      ).statusText
    ).toBe("Lean: Lean exited");

    expect(
      createEditorPlatformShellView(
        snapshot({
          lean: {
            id: "lean",
            kind: "lean-lsp",
            label: "Lean",
            status: { state: "starting" },
            documents: [],
            updatedAt: 2
          }
        }),
        { emptyStatusText: "Idle" }
      ).statusText
    ).toBe("Lean: Starting");
  });
});
