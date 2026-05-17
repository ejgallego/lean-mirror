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

export type HostToEditorMessage =
  | PlatformProtocolEnvelope<"platform-snapshot", { snapshot: EditorPlatformSnapshot }>
  | PlatformProtocolEnvelope<"service-event", { event: ServiceEvent }>
  | PlatformProtocolEnvelope<"document-opened", { document: DocumentSnapshot; text?: string }>
  | PlatformProtocolEnvelope<"diagnostics", { uri: DocumentUri; diagnostics: readonly EditorDiagnostic[] }>
  | PlatformProtocolEnvelope<"log", { event: LogEvent }>;

export type EditorToHostMessage =
  | PlatformProtocolEnvelope<"ready">
  | PlatformProtocolEnvelope<"open-document", { uri: DocumentUri }>
  | PlatformProtocolEnvelope<"document-changed", { uri: DocumentUri; text: string; version?: number }>
  | PlatformProtocolEnvelope<"restart-service", { serviceId: string; reason?: string }>
  | PlatformProtocolEnvelope<"set-active-document", { uri: DocumentUri; languageId?: LanguageId }>;

export type EditorPlatformMessage = HostToEditorMessage | EditorToHostMessage;

const hostToEditorMessageTypes = [
  "platform-snapshot",
  "service-event",
  "document-opened",
  "diagnostics",
  "log"
] as const;

const editorToHostMessageTypes = [
  "ready",
  "open-document",
  "document-changed",
  "restart-service",
  "set-active-document"
] as const;

const editorPlatformMessageTypes = new Set<string>([
  ...hostToEditorMessageTypes,
  ...editorToHostMessageTypes
]);

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
    !!message.payload &&
    typeof message.payload === "object"
  );
}
