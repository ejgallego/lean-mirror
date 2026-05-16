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

export function documentKey(identity: Pick<DocumentIdentity, "uri">): DocumentUri {
  return identity.uri;
}
