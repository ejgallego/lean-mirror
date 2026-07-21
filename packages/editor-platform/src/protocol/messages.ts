import type { EditorDiagnostic } from "../core/diagnostics.js";
import type { DocumentSnapshot, DocumentUri, LanguageId } from "../core/documents.js";
import type { LogEvent } from "../core/logs.js";
import type { ServiceEvent } from "../services/status.js";
import type { EditorPlatformSnapshot } from "../shell/platformStore.js";

export type PlatformProtocolVersion = 1;

export interface PlatformProtocolEnvelope<TType extends string, TPayload extends object = object> {
  protocol: "editor-platform";
  version: PlatformProtocolVersion;
  type: TType;
  payload: TPayload;
}

export type EditorCommandRequestId = string | number;
export type EditorCommandType =
  | "open-document"
  | "document-changed"
  | "restart-service"
  | "set-active-document";

export type EditorCommandResult =
  | {
      command: EditorCommandType;
      handled: boolean;
      ok: true;
      requestId: EditorCommandRequestId;
    }
  | {
      command: EditorCommandType;
      message: string;
      ok: false;
      requestId: EditorCommandRequestId;
    };

export type HostToEditorMessage =
  | PlatformProtocolEnvelope<"platform-snapshot", { snapshot: EditorPlatformSnapshot }>
  | PlatformProtocolEnvelope<"service-event", { event: ServiceEvent }>
  | PlatformProtocolEnvelope<"document-opened", { document: DocumentSnapshot; text?: string }>
  | PlatformProtocolEnvelope<"diagnostics", { uri: DocumentUri; diagnostics: readonly EditorDiagnostic[] }>
  | PlatformProtocolEnvelope<"log", { event: LogEvent }>
  | PlatformProtocolEnvelope<"command-result", EditorCommandResult>;

export type EditorToHostMessage =
  | PlatformProtocolEnvelope<"ready">
  | PlatformProtocolEnvelope<"open-document", { requestId?: EditorCommandRequestId; uri: DocumentUri }>
  | PlatformProtocolEnvelope<"document-changed", { requestId?: EditorCommandRequestId; uri: DocumentUri; text: string; version?: number }>
  | PlatformProtocolEnvelope<"restart-service", { requestId?: EditorCommandRequestId; serviceId: string; reason?: string }>
  | PlatformProtocolEnvelope<"set-active-document", { requestId?: EditorCommandRequestId; uri: DocumentUri; languageId?: LanguageId }>;

export type EditorPlatformMessage = HostToEditorMessage | EditorToHostMessage;

const hostToEditorMessageTypes = [
  "platform-snapshot",
  "service-event",
  "document-opened",
  "diagnostics",
  "log",
  "command-result"
] as const;

const editorToHostMessageTypes = [
  "ready",
  "open-document",
  "document-changed",
  "restart-service",
  "set-active-document"
] as const;

const hostToEditorMessageTypeSet = new Set<string>(hostToEditorMessageTypes);
const editorToHostMessageTypeSet = new Set<string>(editorToHostMessageTypes);
const editorPlatformMessageTypes = new Set<string>([...hostToEditorMessageTypes, ...editorToHostMessageTypes]);

type UnknownRecord = Record<string, unknown>;

const documentOpenStates = new Set(["closed", "opening", "open"]);
const documentSyncStates = new Set(["clean", "dirty", "stale", "failed"]);
const diagnosticSeverities = new Set(["error", "warning", "info", "hint"]);
const serviceStates = new Set(["stopped", "starting", "initializing", "ready", "stale", "stopping", "failed"]);
const serviceEventTypes = new Set(["starting", "initializing", "ready", "stale", "failed", "stopped"]);
const logLevels = new Set(["debug", "info", "warn", "error"]);
const editorCommandTypes = new Set<EditorCommandType>([
  "open-document",
  "document-changed",
  "restart-service",
  "set-active-document"
]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isFiniteNumber(value) && value >= 0;
}

function isCommandRequestId(value: unknown): value is EditorCommandRequestId {
  return isString(value) || isFiniteNumber(value);
}

function hasValidOptionalRequestId(payload: UnknownRecord): boolean {
  return payload.requestId === undefined || isCommandRequestId(payload.requestId);
}

function isEditorCommandResult(value: unknown): value is EditorCommandResult {
  if (
    !isRecord(value) ||
    !isString(value.command) ||
    !editorCommandTypes.has(value.command as EditorCommandType) ||
    !isCommandRequestId(value.requestId) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok
    ? typeof value.handled === "boolean" && value.message === undefined
    : isString(value.message) && value.handled === undefined;
}

function isDocumentIdentity(value: unknown): boolean {
  return isRecord(value) && isString(value.uri) && isString(value.languageId);
}

function isDocumentSnapshot(value: unknown): boolean {
  return (
    isDocumentIdentity(value) &&
    isRecord(value) &&
    isNonNegativeInteger(value.version) &&
    isString(value.openState) &&
    documentOpenStates.has(value.openState) &&
    isString(value.syncState) &&
    documentSyncStates.has(value.syncState) &&
    isOptionalString(value.title) &&
    isOptionalString(value.lastError)
  );
}

function isSourceRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.from) &&
    isNonNegativeInteger(value.to) &&
    value.to >= value.from &&
    value.positionEncoding === "utf16" &&
    (value.rangeBase === "file" || value.rangeBase === "document" || value.rangeBase === "body")
  );
}

function isEditorDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.message) &&
    isString(value.severity) &&
    diagnosticSeverities.has(value.severity) &&
    isOptionalString(value.uri) &&
    isOptionalString(value.source) &&
    isOptionalString(value.code) &&
    (value.range === undefined || isSourceRange(value.range))
  );
}

function isServiceStatus(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.state) || !serviceStates.has(value.state)) {
    return false;
  }
  if (!isOptionalString(value.message)) {
    return false;
  }
  if (value.state === "failed") {
    return isString(value.message) && (value.recoverable === undefined || typeof value.recoverable === "boolean");
  }
  return value.recoverable === undefined;
}

function isServiceEvent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isString(value.type) ||
    !serviceEventTypes.has(value.type) ||
    !isString(value.serviceId) ||
    (value.timestamp !== undefined && !isFiniteNumber(value.timestamp))
  ) {
    return false;
  }
  if (value.type === "failed") {
    return (
      isString(value.message) &&
      (value.recoverable === undefined || typeof value.recoverable === "boolean")
    );
  }
  if (value.type === "stale") {
    return isOptionalString(value.reason);
  }
  return isOptionalString(value.message);
}

function isEditorServiceSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.kind) &&
    isString(value.label) &&
    isServiceStatus(value.status) &&
    Array.isArray(value.documents) &&
    value.documents.every(isDocumentIdentity) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isLogEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.level) &&
    logLevels.has(value.level) &&
    isString(value.message) &&
    isFiniteNumber(value.timestamp) &&
    isOptionalString(value.serviceId) &&
    isOptionalString(value.uri)
  );
}

function isEditorPlatformSnapshot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.services) ||
    !isRecord(value.documents) ||
    !isOptionalString(value.activeDocumentUri) ||
    !Array.isArray(value.diagnostics) ||
    !Array.isArray(value.logs)
  ) {
    return false;
  }
  return (
    Object.values(value.services).every(isEditorServiceSnapshot) &&
    Object.values(value.documents).every(isDocumentSnapshot) &&
    value.diagnostics.every(isEditorDiagnostic) &&
    value.logs.every(isLogEvent)
  );
}

function hasValidPayload(type: string, payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  switch (type) {
    case "platform-snapshot":
      return isEditorPlatformSnapshot(payload.snapshot);
    case "service-event":
      return isServiceEvent(payload.event);
    case "document-opened":
      return isDocumentSnapshot(payload.document) && isOptionalString(payload.text);
    case "diagnostics":
      return (
        isString(payload.uri) &&
        Array.isArray(payload.diagnostics) &&
        payload.diagnostics.every(isEditorDiagnostic)
      );
    case "log":
      return isLogEvent(payload.event);
    case "command-result":
      return isEditorCommandResult(payload);
    case "ready":
      return Object.keys(payload).length === 0;
    case "open-document":
      return isString(payload.uri) && hasValidOptionalRequestId(payload);
    case "document-changed":
      return (
        isString(payload.uri) &&
        isString(payload.text) &&
        hasValidOptionalRequestId(payload) &&
        (payload.version === undefined || isNonNegativeInteger(payload.version))
      );
    case "restart-service":
      return isString(payload.serviceId) && isOptionalString(payload.reason) && hasValidOptionalRequestId(payload);
    case "set-active-document":
      return isString(payload.uri) && isOptionalString(payload.languageId) && hasValidOptionalRequestId(payload);
    default:
      return false;
  }
}

export function platformMessage<TType extends string, TPayload extends object = object>(
  type: TType,
  payload: TPayload = {} as TPayload
): PlatformProtocolEnvelope<TType, TPayload> {
  return {
    protocol: "editor-platform",
    version: 1,
    type,
    payload
  };
}

export function isEditorPlatformMessage(value: unknown): value is EditorPlatformMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Partial<EditorPlatformMessage>;
  return (
    message.protocol === "editor-platform" &&
    message.version === 1 &&
    typeof message.type === "string" &&
    editorPlatformMessageTypes.has(message.type) &&
    hasValidPayload(message.type, message.payload)
  );
}

export function isHostToEditorMessage(value: unknown): value is HostToEditorMessage {
  return isEditorPlatformMessage(value) && hostToEditorMessageTypeSet.has(value.type);
}

export function isEditorToHostMessage(value: unknown): value is EditorToHostMessage {
  return isEditorPlatformMessage(value) && editorToHostMessageTypeSet.has(value.type);
}
