import type {
  DemoPreparationStatus,
  DemoSession,
  RustMainUpdateRequest,
  RustMainUpdateResult,
} from "../shared/demoProtocol.mjs";

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

export interface DemoWorkspace {
  paths: DemoWorkspacePaths;
  uris: DemoWorkspaceUris;
  documentLanguageIds: Record<string, string>;
  prepare(): Promise<void>;
  readPreparationStatus(): DemoPreparationStatus;
  readSession(urls: DemoSessionUrls): Promise<DemoSession>;
  createRustBlockSession(key: string, code: string): Promise<RustBlockSession>;
  readDocument(uri: string): Promise<string>;
  rustBlockPaths(key: string): RustBlockPaths;
  updateRustBlockDocument(key: string, code: string, version?: number): Promise<boolean>;
  updateRustMainDocument(payload: RustMainUpdateRequest): Promise<RustMainUpdateResult>;
}

export function createDemoWorkspace(
  demoDir: string,
  options?: {
    onStatusChange?: (status: DemoPreparationStatus) => void;
  },
): DemoWorkspace;
