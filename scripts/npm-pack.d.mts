export interface NpmPackEntry {
  name: string;
  filename: string;
  files: readonly { path: string }[];
}

export function readNpmPackEntry(output: string, packageName: string): NpmPackEntry;
