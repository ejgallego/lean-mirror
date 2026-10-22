export interface LeanDocumentSnapshot {
  uri: string;
  text: string;
  revision: string;
  /** Previous disk inode retained for recovery; present after a successful save. */
  recoveryPath?: string;
}
export function parseLeanDocumentSave(value: unknown): LeanDocumentSnapshot;
export function createLeanDocumentStore(paths: readonly string[]): {
  read(uri: string): Promise<LeanDocumentSnapshot>;
  save(payload: LeanDocumentSnapshot): Promise<LeanDocumentSnapshot>;
};
