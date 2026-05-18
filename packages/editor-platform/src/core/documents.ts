export type DocumentUri = string;
export type LanguageId = string;

export interface DocumentIdentity {
  uri: DocumentUri;
  languageId: LanguageId;
}

export type DocumentOpenState = "closed" | "opening" | "open";
export type DocumentSyncState = "clean" | "dirty" | "stale" | "failed";

export interface DocumentSnapshot extends DocumentIdentity {
  version: number;
  openState: DocumentOpenState;
  syncState: DocumentSyncState;
  title?: string;
  lastError?: string;
}

export interface InferLanguageIdFromUriOptions {
  fallback?: LanguageId | undefined;
  extensionMap?: Readonly<Record<string, LanguageId>> | undefined;
}

export interface CreateDocumentSnapshotOptions {
  uri: DocumentUri;
  languageId?: LanguageId | undefined;
  languageFallback?: LanguageId | undefined;
  version?: number | undefined;
  openState?: DocumentOpenState | undefined;
  syncState?: DocumentSyncState | undefined;
  title?: string | undefined;
  lastError?: string | undefined;
  previous?: DocumentSnapshot | undefined;
}

const defaultExtensionLanguageIds: Readonly<Record<string, LanguageId>> = {
  ".js": "javascript",
  ".json": "json",
  ".lean": "lean4",
  ".md": "markdown",
  ".rs": "rust",
  ".ts": "typescript",
  ".txt": "text"
};

export function documentKey(identity: Pick<DocumentIdentity, "uri">): DocumentUri {
  return identity.uri;
}

export function documentTitleFromUri(uri: DocumentUri): string {
  const path = uriPathWithoutQueryOrFragment(uri).replace(/\/+$/, "");
  if (path.length === 0) {
    return uri;
  }

  const slashIndex = path.lastIndexOf("/");
  const rawTitle = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  return rawTitle.length > 0 ? decodeUriLabel(rawTitle) : uri;
}

export function inferLanguageIdFromUri(
  uri: DocumentUri,
  options: InferLanguageIdFromUriOptions = {}
): LanguageId {
  const extension = extensionFromUri(uri);
  if (extension) {
    const languageId = options.extensionMap?.[extension] ?? defaultExtensionLanguageIds[extension];
    if (languageId) {
      return languageId;
    }
  }
  return options.fallback ?? "text";
}

export function createDocumentSnapshot(options: CreateDocumentSnapshotOptions): DocumentSnapshot {
  const previous = options.previous;
  const snapshot: DocumentSnapshot = {
    uri: options.uri,
    languageId:
      options.languageId ??
      previous?.languageId ??
      inferLanguageIdFromUri(options.uri, { fallback: options.languageFallback }),
    version: options.version ?? previous?.version ?? 0,
    openState: options.openState ?? previous?.openState ?? "open",
    syncState: options.syncState ?? previous?.syncState ?? "clean"
  };

  const title = options.title ?? previous?.title ?? documentTitleFromUri(options.uri);
  if (title !== undefined) {
    snapshot.title = title;
  }

  if (options.lastError !== undefined) {
    snapshot.lastError = options.lastError;
  }

  return snapshot;
}

function extensionFromUri(uri: DocumentUri): string | undefined {
  const title = documentTitleFromUri(uri);
  const dotIndex = title.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === title.length - 1) {
    return undefined;
  }
  return title.slice(dotIndex).toLowerCase();
}

function uriPathWithoutQueryOrFragment(uri: DocumentUri): string {
  const queryIndex = uri.indexOf("?");
  const fragmentIndex = uri.indexOf("#");
  let endIndex = uri.length;
  if (queryIndex >= 0) {
    endIndex = Math.min(endIndex, queryIndex);
  }
  if (fragmentIndex >= 0) {
    endIndex = Math.min(endIndex, fragmentIndex);
  }
  return uri.slice(0, endIndex);
}

function decodeUriLabel(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
