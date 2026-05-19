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
}

export interface GracefulShutdownOptions {
  exitDelayMs?: number;
}

export interface AttachLspProcessOptions {
  killDelayMs?: number;
  shutdownExitDelayMs?: number;
  state?: LspProcessState;
}

export interface LspSocketLike {
  readyState: number;
  send(message: string): void;
  close(): void;
  on(event: "message", listener: (message: Buffer | string) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface LspChildLike {
  stdout: Pick<Readable, "on">;
  stdin: Pick<Writable, "write" | "end">;
  killed: boolean;
  kill(): unknown;
  on(event: "exit", listener: () => void): unknown;
}

export const defaultIgnorableClosePatterns: readonly RegExp[];
export function createLspProcessState(): LspProcessState;
export function encodeLspFrame(payload: unknown): Buffer;
export function forwardLspFrames(stream: Pick<Readable, "on">, onMessage: (message: string) => void): void;
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
