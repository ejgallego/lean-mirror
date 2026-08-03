export interface LineCommentFenceOptions {
  kind: string;
  linePrefixes: readonly string[];
}

export interface ParsedLineCommentFencedBlock {
  code: string;
  codeLineStarts: readonly number[];
  from: number;
  indent: string;
  info: string | null;
  key: string;
  label: string | null;
  linePrefix: string;
  ordinal: number;
  sourceLine: number;
  to: number;
}

export function parseLineCommentFencedBlocks(
  source: string,
  options: LineCommentFenceOptions,
): ParsedLineCommentFencedBlock[];

export function lineCommentFencedHostFingerprint(
  source: string,
  options: LineCommentFenceOptions,
): string;
