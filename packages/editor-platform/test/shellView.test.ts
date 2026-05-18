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
          { severity: "error", message: "unknown" },
          { severity: "hint", message: "try this" }
        ]
      },
      { hostServiceId: "host" }
    );

    expect(view.statusText).toBe("Ready");
    expect(view.activeDocumentUri).toBe("file:///Main.lean");
    expect(view.diagnosticsText).toBe("1 error, 0 warnings, 1 hint");
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
