import { describe, expect, test } from "vitest";

import {
  isEditorPlatformMessage,
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
});
