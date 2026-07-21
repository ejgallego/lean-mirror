export class DemoRequestTooLargeError extends Error {
  readonly code: "ERR_DEMO_REQUEST_TOO_LARGE";
  constructor(limit: number);
}

export function isLoopbackHost(host: string): boolean;
export function assertSafeDemoBind(host: string, allowRemote: boolean): void;
export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number;
export function parseAllowedOrigins(
  value: string | undefined,
  defaults: readonly string[],
): Set<string>;
export function requestOriginAllowed(origin: string | undefined, allowedOrigins: ReadonlySet<string>): boolean;
export function readBoundedJsonBody(
  req: AsyncIterable<string | Uint8Array>,
  maxBytes: number,
): Promise<unknown>;
