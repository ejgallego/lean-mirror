export interface DemoSession {
  rootUri: string;
  documentUri: string;
  documentLanguageIds?: Record<string, string>;
  documents: string[];
  embeddedLeanDocumentUri?: string;
  initialDoc: string;
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

export const DEMO_ENDPOINTS: Readonly<{
  document: "/document";
  rustDocument: "/rust-document";
  rustMain: "/rust-main";
  rustSession: "/rust-session";
  session: "/session";
}>;

export function documentEndpoint(apiBase: string, uri: string): string;
export function parseDemoSession(value: unknown): DemoSession;
export function parseDocumentResponse(value: unknown): DocumentResponse;
export function parseCreateRustSessionRequest(value: unknown): CreateRustSessionRequest;
export function parseRustSession(value: unknown): RustSession;
export function parseUpdateRustDocumentRequest(value: unknown): UpdateRustDocumentRequest;
export function parseRustMainUpdateRequest(value: unknown): RustMainUpdateRequest;
export function parseRustMainUpdateResult(value: unknown): RustMainUpdateResult;
