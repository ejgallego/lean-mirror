export interface LeanDocumentSnapshot {
  uri: string;
  text: string;
  revision: string;
}
export function parseLeanDocumentSave(value: unknown): LeanDocumentSnapshot;
export function createLeanDocumentStore(paths: readonly string[]): {
  read(uri: string): Promise<LeanDocumentSnapshot>;
  save(payload: LeanDocumentSnapshot): Promise<LeanDocumentSnapshot>;
};
