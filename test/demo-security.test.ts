import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  DemoRequestTooLargeError,
  assertSafeDemoBind,
  isLoopbackHost,
  parseAllowedOrigins,
  readBoundedJsonBody,
  requestHostAllowed,
  requestOriginAllowed,
} from "../demo/server/security.mjs";

describe("demo server security policy", () => {
  it("binds to loopback unless remote exposure is explicitly acknowledged", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(() => assertSafeDemoBind("0.0.0.0", false)).toThrow(/LEAN_DEMO_ALLOW_REMOTE/);
    expect(() => assertSafeDemoBind("0.0.0.0", true)).not.toThrow();
  });

  it("uses an explicit browser-origin allowlist", () => {
    const origins = parseAllowedOrigins(undefined, ["http://127.0.0.1:5173"]);
    expect(requestOriginAllowed(undefined, origins)).toBe(true);
    expect(requestOriginAllowed("http://127.0.0.1:5173", origins)).toBe(true);
    expect(requestOriginAllowed("https://attacker.example", origins)).toBe(false);
  });

  it("rejects non-loopback Host headers unless remote exposure is acknowledged", () => {
    for (const host of ["127.0.0.1:7357", "localhost:7357", "[::1]:7357", "localhost", undefined]) {
      expect(requestHostAllowed(host, false)).toBe(true);
    }
    for (const host of ["attacker.example:7357", "127.0.0.1.attacker.example", "", "[bad"]) {
      expect(requestHostAllowed(host, false)).toBe(false);
    }
    expect(requestHostAllowed("demo.internal:7357", true)).toBe(true);
  });

  it("rejects JSON bodies over the configured limit", async () => {
    await expect(readBoundedJsonBody(Readable.from(['{"value":"too large"}']), 8)).rejects.toBeInstanceOf(
      DemoRequestTooLargeError,
    );
    await expect(readBoundedJsonBody(Readable.from(['{"ok":true}']), 32)).resolves.toEqual({ ok: true });
  });
});
