export interface DemoWorkspacePaths {
  workspaceDir: string;
  rustBlocksDir: string;
  rustMainPath: string;
}

export interface DemoWorkspaceUris {
  rootUri: string;
  documentUri: string;
  rustMainUri: string;
  helperUri: string;
  embeddedLeanUri: string;
}

export interface DemoSessionUrls {
  websocketUrl: string;
  rustMainWebsocketUrl: string;
}

export interface RustBlockSession {
  documentPath: string;
  documentUri: string;
  rootPath: string;
  rootUri: string;
  slug: string;
}

export interface RustBlockPaths {
  documentPath: string;
  rootPath: string;
  slug: string;
}

export interface RustMainUpdatePayload {
  code: string;
  leanDocument: string;
  revision: number;
}

export interface RustMainUpdateResult {
  leanDocumentUri: string;
  revision: number;
}

export interface DemoWorkspace {
  paths: DemoWorkspacePaths;
  uris: DemoWorkspaceUris;
  documentLanguageIds: Record<string, string>;
  prepare(): Promise<void>;
  readSession(urls: DemoSessionUrls): Promise<{
    rootUri: string;
    documentUri: string;
    documentLanguageIds: Record<string, string>;
    documents: string[];
    embeddedLeanDocumentUri: string;
    initialDoc: string;
    rustMainDocumentUri: string;
    rustMainWebsocketUrl: string;
    websocketUrl: string;
  }>;
  createRustBlockSession(key: string, code: string): Promise<RustBlockSession>;
  readDocument(uri: string): Promise<string>;
  rustBlockPaths(key: string): RustBlockPaths;
  updateRustBlockDocument(key: string, code: string, version?: number): Promise<boolean>;
  updateRustMainDocument(payload: RustMainUpdatePayload): Promise<RustMainUpdateResult>;
}

export function createDemoWorkspace(demoDir: string): DemoWorkspace;
