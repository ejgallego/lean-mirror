export class DemoRequestTooLargeError extends Error {
  constructor(limit) {
    super(`Demo request body exceeds the ${limit}-byte limit.`);
    this.name = "DemoRequestTooLargeError";
    this.code = "ERR_DEMO_REQUEST_TOO_LARGE";
  }
}

export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function assertSafeDemoBind(host, allowRemote) {
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing to expose the demo backend on ${host}. Set LEAN_DEMO_ALLOW_REMOTE=1 to acknowledge the risk.`,
    );
  }
}

export function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseAllowedOrigins(value, defaults) {
  const configured = value?.split(",").map((origin) => origin.trim()).filter(Boolean);
  return new Set(configured && configured.length > 0 ? configured : defaults);
}

export function requestOriginAllowed(origin, allowedOrigins) {
  return origin === undefined || allowedOrigins.has(origin);
}

export async function readBoundedJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new DemoRequestTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
