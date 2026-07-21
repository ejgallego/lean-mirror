import { describe, expect, test } from "vitest";

import {
  isEditorPlatformMessage,
  isEditorToHostMessage,
  platformMessage,
  type EditorToHostMessage,
  type HostToEditorMessage
} from "../src/index.js";

describe("platform protocol messages", () => {
  test("wraps host/editor messages in a versioned protocol envelope", () => {
    const message: HostToEditorMessage = platformMessage("service-event", {
      event: {
        type: "ready",
        serviceId: "lean"
      }
    } satisfies HostToEditorMessage["payload"]);

    expect(message).toEqual({
      protocol: "editor-platform",
      version: 1,
      type: "service-event",
      payload: {
        event: {
          type: "ready",
          serviceId: "lean"
        }
      }
    });
  });

  test("supports editor-to-host commands", () => {
    const message: EditorToHostMessage = platformMessage("restart-service", {
      serviceId: "lean",
      reason: "manual retry"
    });

    expect(isEditorPlatformMessage(message)).toBe(true);
    expect(message.payload).toEqual({
      serviceId: "lean",
      reason: "manual retry"
    });
  });

  test("rejects unrelated messages", () => {
    expect(isEditorPlatformMessage({ type: "ready" })).toBe(false);
    expect(isEditorPlatformMessage({ protocol: "editor-platform", version: 2, type: "ready" })).toBe(false);
    expect(isEditorPlatformMessage({ protocol: "editor-platform", version: 1, type: "unknown", payload: {} })).toBe(
      false
    );
    expect(isEditorPlatformMessage({ protocol: "editor-platform", version: 1, type: "ready" })).toBe(false);
    expect(isEditorPlatformMessage(null)).toBe(false);
  });

  test("rejects malformed payloads at every protocol boundary", () => {
    const envelope = (type: string, payload: unknown) => ({
      protocol: "editor-platform",
      version: 1,
      type,
      payload
    });

    expect(isEditorToHostMessage(envelope("ready", []))).toBe(false);
    expect(isEditorToHostMessage(envelope("ready", { unexpected: true }))).toBe(false);
    expect(isEditorToHostMessage(envelope("open-document", {}))).toBe(false);
    expect(isEditorToHostMessage(envelope("set-active-document", { uri: 42 }))).toBe(false);
    expect(
      isEditorToHostMessage(envelope("document-changed", { uri: "file:///Main.lean", text: 4 }))
    ).toBe(false);
    expect(
      isEditorToHostMessage(
        envelope("document-changed", { uri: "file:///Main.lean", text: "", version: -1 })
      )
    ).toBe(false);
    expect(
      isEditorPlatformMessage(
        envelope("diagnostics", {
          uri: "file:///Main.lean",
          diagnostics: [{ message: "bad", severity: "fatal" }]
        })
      )
    ).toBe(false);
    expect(
      isEditorPlatformMessage(
        envelope("service-event", { event: { type: "failed", serviceId: "lean" } })
      )
    ).toBe(false);
    expect(
      isEditorPlatformMessage(
        envelope("document-opened", {
          document: {
            uri: "file:///Main.lean",
            languageId: "lean4",
            version: 0,
            openState: "visible",
            syncState: "clean"
          }
        })
      )
    ).toBe(false);
  });
});
