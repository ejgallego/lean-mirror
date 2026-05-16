import type { DocumentUri } from "./documents.js";

export type PositionEncoding = "utf16";
export type RangeBase = "file" | "document" | "body";

export interface SourceRange {
  from: number;
  to: number;
  positionEncoding: PositionEncoding;
  rangeBase: RangeBase;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface EditorDiagnostic {
  message: string;
  severity: DiagnosticSeverity;
  uri?: DocumentUri;
  source?: string;
  code?: string;
  range?: SourceRange;
}

export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
}

export function summarizeDiagnostics(diagnostics: readonly EditorDiagnostic[]): DiagnosticSummary {
  const summary: DiagnosticSummary = {
    errors: 0,
    warnings: 0,
    infos: 0,
    hints: 0
  };

  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case "error":
        summary.errors += 1;
        break;
      case "warning":
        summary.warnings += 1;
        break;
      case "info":
        summary.infos += 1;
        break;
      case "hint":
        summary.hints += 1;
        break;
    }
  }

  return summary;
}
