import type { DocumentUri } from "./documents.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  message: string;
  timestamp: number;
  serviceId?: string;
  uri?: DocumentUri;
  details?: unknown;
}
