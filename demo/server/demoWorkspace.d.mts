import type {
  DemoPreparationStatus,
  DemoSession,
  RustMainUpdateRequest,
  RustMainUpdateResult,
} from "../shared/demoProtocol.mjs";

export interface DemoWorkspacePaths {
  workspaceDir: string;
  rustWorkspaceDir: string;
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
  regenerateRustMainDocument(payload: RustMainUpdateRequest, urls: DemoSessionUrls): Promise<DemoSession>;
  rustBlockPaths(key: string): RustBlockPaths;
  switchExample(exampleId: string): Promise<void>;
  updateRustBlockDocument(key: string, code: string, version?: number): Promise<boolean>;
  updateRustMainDocument(payload: RustMainUpdateRequest): Promise<RustMainUpdateResult>;
}

export function createDemoWorkspace(
  demoDir: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onStatusChange?: (status: DemoPreparationStatus) => void;
  },
): DemoWorkspace;
