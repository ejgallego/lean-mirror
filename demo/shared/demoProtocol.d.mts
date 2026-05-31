export interface DemoExample {
  id: string;
  label: string;
  ready?: boolean;
  summary?: string;
}

export interface DemoPreparationStatus {
  detail?: string;
  message: string;
  phase: "idle" | "preparing" | "ready" | "failed";
  updatedAt: string;
}

export interface DemoSession {
  activeExampleId?: string;
  availableExamples?: DemoExample[];
  canRegenerate?: boolean;
  demoProject?: string;
  demoSummary?: string;
  demoTitle?: string;
  preparationStatus?: DemoPreparationStatus;
  rootUri: string;
  documentUri: string;
  documentLanguageIds?: Record<string, string>;
  documents: string[];
  embeddedLeanDefaultImports?: string[];
  embeddedLeanDocumentUri?: string;
  embeddedLeanPreamble?: string[];
  embeddedLeanPostamble?: string[];
  initialDoc: string;
  rustRootUri?: string;
  rustMainDocumentUri?: string;
  rustMainWebsocketUrl?: string;
  websocketUrl: string;
}

export interface DocumentResponse {
  uri?: string;
  text: string;
}

export interface CreateRustSessionRequest {
  code: string;
  key: string;
}

export interface RustSession {
  documentUri: string;
  rootUri: string;
  websocketUrl: string;
}

export interface UpdateRustDocumentRequest {
  code: string;
  key: string;
  version?: number;
}

export interface RustMainUpdateRequest {
  code: string;
  leanDocument: string;
  revision: number;
  uri: string;
}

export interface RustMainUpdateResult {
  leanDocumentUri: string;
  revision: number;
  stale?: boolean;
}

export interface SwitchExampleRequest {
  id: string;
}

export const DEMO_ENDPOINTS: Readonly<{
  document: "/document";
  regenerateRustMain: "/regenerate-rust-main";
  rustDocument: "/rust-document";
  rustMain: "/rust-main";
  rustSession: "/rust-session";
  session: "/session";
  status: "/status";
  switchExample: "/switch-example";
}>;

export function documentEndpoint(apiBase: string, uri: string): string;
export function parseDemoSession(value: unknown): DemoSession;
export function parseDemoPreparationStatus(value: unknown): DemoPreparationStatus;
export function parseDocumentResponse(value: unknown): DocumentResponse;
export function parseCreateRustSessionRequest(value: unknown): CreateRustSessionRequest;
export function parseRustSession(value: unknown): RustSession;
export function parseUpdateRustDocumentRequest(value: unknown): UpdateRustDocumentRequest;
export function parseRustMainUpdateRequest(value: unknown): RustMainUpdateRequest;
export function parseRustMainUpdateResult(value: unknown): RustMainUpdateResult;
export function parseSwitchExampleRequest(value: unknown): SwitchExampleRequest;
