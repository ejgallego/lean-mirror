import { describe, expect, test } from "vitest";

import {
  diagnosticsForDocument,
  groupDiagnosticsByDocument,
  summarizeDiagnosticsForDocument,
  type EditorDiagnostic
} from "../src/index.js";

const main = "file:///workspace/Main.lean";
const helper = "file:///workspace/Helper.lean";

const diagnostics: readonly EditorDiagnostic[] = [
  { uri: main, severity: "error", message: "unknown identifier" },
  { uri: helper, severity: "warning", message: "unused variable" },
  { uri: main, severity: "hint", message: "try this" },
  { severity: "info", message: "global service note" }
];

describe("editor platform diagnostics", () => {
  test("filters diagnostics for one document", () => {
    expect(diagnosticsForDocument(diagnostics, main)).toEqual([
      { uri: main, severity: "error", message: "unknown identifier" },
      { uri: main, severity: "hint", message: "try this" }
    ]);
  });

  test("can include unscoped diagnostics in document views", () => {
    expect(diagnosticsForDocument(diagnostics, helper, { includeUnscoped: true })).toEqual([
      { uri: helper, severity: "warning", message: "unused variable" },
      { severity: "info", message: "global service note" }
    ]);
  });

  test("summarizes diagnostics for one document", () => {
    expect(summarizeDiagnosticsForDocument(diagnostics, main)).toEqual({
      errors: 1,
      warnings: 0,
      infos: 0,
      hints: 1
    });
  });

  test("groups diagnostics by document while preserving unscoped diagnostics", () => {
    const grouped = groupDiagnosticsByDocument(diagnostics);

    expect(Array.from(grouped.documents.entries())).toEqual([
      [
        main,
        [
          { uri: main, severity: "error", message: "unknown identifier" },
          { uri: main, severity: "hint", message: "try this" }
        ]
      ],
      [helper, [{ uri: helper, severity: "warning", message: "unused variable" }]]
    ]);
    expect(grouped.unscoped).toEqual([{ severity: "info", message: "global service note" }]);
  });
});
