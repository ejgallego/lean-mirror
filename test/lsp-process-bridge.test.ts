import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createLspProcessState,
  encodeLspFrame,
  forwardLspFrames,
  normalizeClientLspPayload,
  pipeServerStderr,
  requestGracefulShutdown,
} from "../demo/server/lspProcessBridge.mjs";

describe("demo LSP process bridge", () => {
  it("forwards complete LSP frames from arbitrary stream chunks", () => {
    const stream = new PassThrough();
    const messages: string[] = [];
    const first = { jsonrpc: "2.0", method: "first" };
    const second = { jsonrpc: "2.0", method: "second" };
    const firstFrame = encodeLspFrame(first);
    const secondFrame = encodeLspFrame(second);

    forwardLspFrames(stream, (message) => {
      messages.push(message);
    });

    stream.write(firstFrame.subarray(0, 12));
    stream.write(Buffer.concat([firstFrame.subarray(12), secondFrame]));

    expect(messages).toEqual([JSON.stringify(first), JSON.stringify(second)]);
  });

  it("normalizes legacy cancelRequest payloads for Lean", () => {
    const cancel = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: 7,
      }),
    );
    const alreadyObject = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id: 7 },
      }),
    );
    const invalid = Buffer.from("not json");

    expect(JSON.parse(normalizeClientLspPayload(cancel).toString("utf8"))).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 7 },
    });
    expect(normalizeClientLspPayload(alreadyObject)).toBe(alreadyObject);
    expect(normalizeClientLspPayload(invalid)).toBe(invalid);
  });

  it("filters expected close noise from server stderr", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const ended = new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
    });

    pipeServerStderr(stream, {
      onLine(line) {
        lines.push(line);
      },
    });

    stream.write("ordinary line\n");
    stream.write("client exited without proper shutdown sequence\n");
    stream.write("stack frame hidden with the expected close block\n");
    stream.write("\n");
    stream.end("tail line");
    await ended;

    expect(lines).toEqual(["ordinary line", "tail line"]);
  });

  it("sends shutdown and exit frames for initialized processes", () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const chunks: Buffer[] = [];
      stdin.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const state = createLspProcessState();
      state.initialized = true;

      requestGracefulShutdown({ stdin, killed: false }, state, { exitDelayMs: 0 });
      vi.runAllTimers();

      const written = Buffer.concat(chunks).toString("utf8");
      expect(state.shutdownSent).toBe(true);
      expect(written).toContain("\"method\":\"shutdown\"");
      expect(written).toContain("\"method\":\"exit\"");
    } finally {
      vi.useRealTimers();
    }
  });
});
