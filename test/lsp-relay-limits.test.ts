import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachLspProcess, encodeLspFrame, forwardLspFrames, pipeServerStderr } from "../demo/server/lspProcessBridge.mjs";

afterEach(() => { vi.useRealTimers(); });
class Socket extends EventEmitter {
  readyState = 1;
  messages: string[] = [];
  callbacks: (() => void)[] = [];
  hold = false;
  pause = vi.fn();
  resume = vi.fn();
  send(message: string, callback?: (error?: Error) => void) {
    this.messages.push(message);
    if (this.hold && callback) this.callbacks.push(callback);
    else callback?.();
  }
  close() { this.readyState = 3; this.emit("close"); }
}
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), killed: false,
    kill: vi.fn(),
  });
}

describe("bounded LSP process relay", () => {
  it("contains malformed output to one session and keeps another usable", () => {
    vi.useFakeTimers();
    const bad = child(), good = child();
    const first = new Socket(), second = new Socket();
    const errors = vi.fn();
    attachLspProcess(first, bad, { onError: errors });
    const healthy = attachLspProcess(second, good);
    expect(() => bad.stdout.write("not-an-lsp-header\r\n\r\n")).not.toThrow();
    expect(errors).toHaveBeenCalledOnce();
    expect(first.readyState).toBe(3);
    good.stdout.write(encodeLspFrame({ jsonrpc: "2.0", method: "healthy" }));
    expect(JSON.parse(second.messages[0]!).method).toBe("healthy");
    vi.runAllTimers();
    expect(bad.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    healthy.shutdown();
    good.emit("exit"); bad.emit("exit");
  });

  it.each([
    "Content-Length: 999999999\r\n\r\n",
    "Content-Length: 9007199254740993\r\n\r\n",
    "Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
    "x".repeat(65),
  ])("rejects oversized, unsafe and duplicate headers without buffering the body", (header) => {
    const input = new PassThrough();
    const onError = vi.fn();
    forwardLspFrames(input, vi.fn(), { maxHeaderBytes: 64, maxFrameBytes: 128, onError });
    input.write(header);
    expect(onError).toHaveBeenCalledOnce();
    expect(input.listenerCount("data")).toBe(0);
  });

  it("accepts coalesced valid frames followed by a fragmented frame", () => {
    const input = new PassThrough();
    const messages: string[] = [];
    const onError = vi.fn();
    forwardLspFrames(input, (message) => messages.push(message), { maxFrameBytes: 128, maxHeaderBytes: 64, onError });
    const frame = encodeLspFrame({ jsonrpc: "2.0", method: "small" });
    const partial = frame.subarray(0, frame.length - 3);
    input.write(Buffer.concat([...Array.from({ length: 400 }, () => frame), partial]));
    expect(messages).toHaveLength(400);
    input.write(frame.subarray(frame.length - 3));
    expect(messages).toHaveLength(401);
    expect(onError).not.toHaveBeenCalled();
  });

  it("truncates long stderr lines and resumes normal line reporting", () => {
    const input = new PassThrough();
    const onLine = vi.fn();
    pipeServerStderr(input, { maxLineLength: 8, onLine });
    input.write("x".repeat(100));
    input.write("y".repeat(100) + "\nnormal\n");
    expect(onLine.mock.calls).toEqual([["xxxxxxxx [truncated]"], ["normal"]]);
  });

  it("rejects a truncated frame at EOF", () => {
    const input = new PassThrough();
    const onError = vi.fn();
    forwardLspFrames(input, vi.fn(), { onError });
    input.write("Content-Length: 100\r\n\r\nshort");
    input.emit("end");
    expect(onError.mock.calls[0]?.[0].message).toMatch(/Incomplete/);
  });

  it("honors slow child backpressure and bounds additional queued input", () => {
    vi.useFakeTimers();
    const process = child();
    const writes: string[] = [];
    const callbacks: (() => void)[] = [];
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      writes.push(chunk.toString()); callbacks.push(callback);
    } });
    const slow = { ...process, stdin, on: process.on.bind(process), kill: process.kill };
    const socket = new Socket();
    const errors = vi.fn();
    attachLspProcess(socket, slow, { maxQueuedBytes: 160, onError: errors });
    const message = JSON.stringify({ jsonrpc: "2.0", method: "small" });
    socket.emit("message", message);
    socket.emit("message", message);
    expect(writes).toHaveLength(1);
    expect(socket.pause).toHaveBeenCalled();
    socket.emit("message", message);
    expect(errors).toHaveBeenCalledOnce();
    expect(stdin.writableLength).toBeLessThan(160);
    expect(socket.readyState).toBe(3);
    process.emit("exit");
    for (const callback of callbacks) callback();
  });

  it("bounds a slow WebSocket reader and drops queued work on shutdown", () => {
    vi.useFakeTimers();
    const process = child();
    const socket = new Socket(); socket.hold = true;
    const onError = vi.fn();
    attachLspProcess(socket, process, { maxQueuedBytes: 100, onError });
    const frame = encodeLspFrame({ jsonrpc: "2.0", method: "output", params: "x".repeat(20) });
    process.stdout.write(frame);
    expect(process.stdout.isPaused()).toBe(true);
    // A buffered chunk can contain more frames even after pause was requested.
    process.stdout.emit("data", frame);
    expect(onError).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    socket.callbacks[0]?.();
    expect(socket.messages).toHaveLength(1);
    process.emit("exit");
  });

  it("cancels termination timers after the child exits", () => {
    vi.useFakeTimers();
    const process = child();
    const relay = attachLspProcess(new Socket(), process);
    relay.shutdown();
    process.emit("exit");
    vi.runAllTimers();
    expect(process.kill).not.toHaveBeenCalled();
  });
});
