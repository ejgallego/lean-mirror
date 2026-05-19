import type { LogLevel } from "../core/logs.js";
import {
  serviceEventFromConnectionStatus,
  type EditorServiceDescriptor,
  type ServiceConnectionStatus,
  type ServiceEvent
} from "../services/status.js";
import type { EditorPlatformStore } from "./platformStore.js";

export type ServiceRequestId = string | number;

export type ServiceRequestEvent =
  | {
      type: "request-started";
      serviceId: string;
      requestId: ServiceRequestId;
      method: string;
      timestamp?: number;
    }
  | {
      type: "request-succeeded";
      serviceId: string;
      requestId: ServiceRequestId;
      method: string;
      durationMs?: number;
      timestamp?: number;
    }
  | {
      type: "request-failed";
      serviceId: string;
      requestId: ServiceRequestId;
      method: string;
      message: string;
      durationMs?: number;
      timestamp?: number;
    };

export interface ServiceRequestHandle {
  readonly requestId: ServiceRequestId;
  readonly method: string;
  readonly startedAt: number;
  succeeded(message?: string): void;
  failed(error: unknown): void;
}

export interface EditorServiceRuntimeOptions {
  maxLogEntries?: number;
  now?: () => number;
  requestIdPrefix?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EditorServiceRuntime {
  private nextRequestSequence = 0;

  constructor(
    readonly store: EditorPlatformStore,
    readonly descriptor: EditorServiceDescriptor,
    private readonly options: EditorServiceRuntimeOptions = {}
  ) {}

  starting(message?: string): void {
    this.record({
      type: "starting",
      serviceId: this.descriptor.id,
      ...(message ? { message } : {})
    });
  }

  connecting(message?: string): void {
    this.recordConnectionStatus({
      phase: "connecting",
      ...(message ? { message } : {})
    });
  }

  initializing(message?: string): void {
    this.recordConnectionStatus({
      phase: "initializing",
      ...(message ? { message } : {})
    });
  }

  ready(message?: string): void {
    this.record({
      type: "ready",
      serviceId: this.descriptor.id,
      ...(message ? { message } : {})
    });
  }

  stale(reason?: string): void {
    this.record({
      type: "stale",
      serviceId: this.descriptor.id,
      ...(reason ? { reason } : {})
    });
  }

  failed(message: string, options: { recoverable?: boolean } = {}): void {
    this.record({
      type: "failed",
      serviceId: this.descriptor.id,
      message,
      ...(options.recoverable === undefined ? {} : { recoverable: options.recoverable })
    });
  }

  stopped(message?: string): void {
    this.record({
      type: "stopped",
      serviceId: this.descriptor.id,
      ...(message ? { message } : {})
    });
  }

  recordConnectionStatus(status: ServiceConnectionStatus): void {
    this.record(serviceEventFromConnectionStatus(this.descriptor.id, status));
  }

  record(event: ServiceEvent): void {
    const timestamp = event.timestamp ?? this.now();
    this.store.recordServiceEvent(this.descriptor, { ...event, timestamp });
    this.log(this.lifecycleLogLevel(event), this.lifecycleMessage(event), {
      event: { ...event, timestamp }
    });
  }

  beginRequest(method: string, requestId: ServiceRequestId = this.nextRequestId()): ServiceRequestHandle {
    const startedAt = this.now();
    let settled = false;

    this.recordRequestEvent({
      type: "request-started",
      serviceId: this.descriptor.id,
      requestId,
      method,
      timestamp: startedAt
    });

    return {
      requestId,
      method,
      startedAt,
      succeeded: () => {
        if (settled) return;
        settled = true;
        const timestamp = this.now();
        this.recordRequestEvent({
          type: "request-succeeded",
          serviceId: this.descriptor.id,
          requestId,
          method,
          durationMs: timestamp - startedAt,
          timestamp
        });
      },
      failed: (error: unknown) => {
        if (settled) return;
        settled = true;
        const timestamp = this.now();
        this.recordRequestEvent({
          type: "request-failed",
          serviceId: this.descriptor.id,
          requestId,
          method,
          message: errorMessage(error),
          durationMs: timestamp - startedAt,
          timestamp
        });
      }
    };
  }

  recordRequestEvent(event: ServiceRequestEvent): void {
    if (event.serviceId !== this.descriptor.id) {
      throw new Error(`Request event for ${event.serviceId} cannot update ${this.descriptor.id}.`);
    }

    const level: LogLevel = event.type === "request-failed" ? "error" : "debug";
    this.log(level, this.requestMessage(event), { event });
  }

  log(level: LogLevel, message: string, details?: unknown): void {
    this.store.appendLog(
      {
        level,
        message,
        serviceId: this.descriptor.id,
        timestamp: this.now(),
        ...(details === undefined ? {} : { details })
      },
      this.options.maxLogEntries === undefined ? {} : { maxEntries: this.options.maxLogEntries }
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nextRequestId(): string {
    this.nextRequestSequence += 1;
    return `${this.options.requestIdPrefix ?? this.descriptor.id}:${this.nextRequestSequence}`;
  }

  private lifecycleLogLevel(event: ServiceEvent): LogLevel {
    if (event.type === "failed") return "error";
    if (event.type === "stale") return "warn";
    return "info";
  }

  private lifecycleMessage(event: ServiceEvent): string {
    switch (event.type) {
      case "starting":
        return event.message ? `${this.descriptor.label} starting: ${event.message}` : `${this.descriptor.label} starting`;
      case "initializing":
        return event.message
          ? `${this.descriptor.label} initializing: ${event.message}`
          : `${this.descriptor.label} initializing`;
      case "ready":
        return event.message ? `${this.descriptor.label} ready: ${event.message}` : `${this.descriptor.label} ready`;
      case "stale":
        return event.reason ? `${this.descriptor.label} stale: ${event.reason}` : `${this.descriptor.label} stale`;
      case "failed":
        return `${this.descriptor.label} failed: ${event.message}`;
      case "stopped":
        return event.message ? `${this.descriptor.label} stopped: ${event.message}` : `${this.descriptor.label} stopped`;
    }
  }

  private requestMessage(event: ServiceRequestEvent): string {
    switch (event.type) {
      case "request-started":
        return `${this.descriptor.label} request started: ${event.method}`;
      case "request-succeeded":
        return `${this.descriptor.label} request completed: ${event.method}`;
      case "request-failed":
        return `${this.descriptor.label} request failed: ${event.method}: ${event.message}`;
    }
  }
}
