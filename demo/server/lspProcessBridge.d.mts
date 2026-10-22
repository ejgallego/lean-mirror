import type { Readable, Writable } from "node:stream";

export interface LspProcessState {
  expectedClose: boolean;
  initialized: boolean;
  shutdownSent: boolean;
}

export interface PipeServerStderrOptions {
  ignoredPatterns?: readonly RegExp[];
  onLine?: (line: string) => void;
  shouldSkipFollowingLines?: (line: string) => boolean;
  maxLineLength?: number;
}

export interface GracefulShutdownOptions {
  exitDelayMs?: number;
}

export interface AttachLspProcessOptions {
  killDelayMs?: number;
  killEscalationMs?: number;
  shutdownExitDelayMs?: number;
  maxQueuedBytes?: number;
  maxHeaderBytes?: number;
  maxFrameBytes?: number;
  onError?: (error: Error) => void;
  state?: LspProcessState;
}

export interface LspSocketLike {
  readyState: number;
  send(message: string, callback?: (error?: Error) => void): void;
  pause?(): void;
  resume?(): void;
  close(): void;
  on(event: "message", listener: (message: Buffer | string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface LspChildLike {
  stdout: Pick<Readable, "on" | "off" | "pause" | "resume" | "destroy">;
  stdin: Pick<Writable, "write" | "end" | "on" | "off" | "writableLength">;
  killed: boolean;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export const defaultIgnorableClosePatterns: readonly RegExp[];
export function createLspProcessState(): LspProcessState;
export function encodeLspFrame(payload: unknown): Buffer;
export function forwardLspFrames(
  stream: Pick<Readable, "on" | "off" | "destroy">,
  onMessage: (message: string) => void,
  options?: { maxHeaderBytes?: number; maxFrameBytes?: number; onError?: (error: Error) => void },
): { dispose(): void };
export function pipeServerStderr(stream: Pick<Readable, "on">, options?: PipeServerStderrOptions): void;
export function writeLspFrame(stream: Pick<Writable, "write">, payload: unknown): void;
export function normalizeClientLspPayload(payload: Buffer): Buffer;
export function noteClientLspMessage(state: LspProcessState, payload: Buffer): void;
export function requestGracefulShutdown(
  child: Pick<LspChildLike, "stdin" | "killed">,
  state: LspProcessState,
  options?: GracefulShutdownOptions
): void;
export function attachLspProcess(
  socket: LspSocketLike,
  child: LspChildLike,
  options?: AttachLspProcessOptions
): { shutdown: () => void; state: LspProcessState };
