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

export interface DiagnosticsForDocumentOptions {
  includeUnscoped?: boolean | undefined;
}

export interface DiagnosticsByDocument {
  documents: ReadonlyMap<DocumentUri, readonly EditorDiagnostic[]>;
  unscoped: readonly EditorDiagnostic[];
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

export function diagnosticsForDocument(
  diagnostics: readonly EditorDiagnostic[],
  uri: DocumentUri,
  options: DiagnosticsForDocumentOptions = {}
): readonly EditorDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => diagnostic.uri === uri || (options.includeUnscoped && diagnostic.uri === undefined)
  );
}

export function summarizeDiagnosticsForDocument(
  diagnostics: readonly EditorDiagnostic[],
  uri: DocumentUri,
  options: DiagnosticsForDocumentOptions = {}
): DiagnosticSummary {
  return summarizeDiagnostics(diagnosticsForDocument(diagnostics, uri, options));
}

export function groupDiagnosticsByDocument(diagnostics: readonly EditorDiagnostic[]): DiagnosticsByDocument {
  const documents = new Map<DocumentUri, EditorDiagnostic[]>();
  const unscoped: EditorDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    if (!diagnostic.uri) {
      unscoped.push(diagnostic);
      continue;
    }

    const documentDiagnostics = documents.get(diagnostic.uri);
    if (documentDiagnostics) {
      documentDiagnostics.push(diagnostic);
    } else {
      documents.set(diagnostic.uri, [diagnostic]);
    }
  }

  return { documents, unscoped };
}
