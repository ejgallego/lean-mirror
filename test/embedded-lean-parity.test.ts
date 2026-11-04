import { describe, expect, it } from "vitest";
import { buildEmbeddedLeanDocument, mapEmbeddedLeanDiagnostics } from "../demo/src/embeddedLean.js";
import { buildEmbeddedLeanDocumentFromSource } from "../demo/server/embeddedLeanDocument.mjs";

describe("embedded Lean browser/backend parity", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const header of ["imports", "prelude", "editor-prelude, test", "  prelude  , test "]) {
      it(`keeps generated text and Unicode mappings identical for ${JSON.stringify({ header, ending })}`, () => {
        const source = [
          "/// ```lean check", '/// #check "𝒜"', "/// ", "/// ```",
          "/// ```lean " + header, "/// import Helper", "/// ```", "",
        ].join(ending);
        const options = { sourceName: "Main.rs", defaultImports: ["Init"], preamble: ["-- preamble"], postamble: ["-- tail"] };
        const browser = buildEmbeddedLeanDocument(source, options);
        expect(browser.doc).toBe(buildEmbeddedLeanDocumentFromSource(source, options));
        expect(browser.doc.indexOf("import Helper")).toBeLessThan(browser.doc.indexOf("#check"));
        const mapping = browser.mappings.find((item) => item.blockKey === "lean:check")!;
        expect(browser.doc.split("\n")[mapping.generatedLine]).toBe('#check "𝒜"');
        const diagnostics = mapEmbeddedLeanDiagnostics(browser, [{
          message: "Unicode", range: { start: { line: mapping.generatedLine, character: 8 },
            end: { line: mapping.generatedLine, character: 10 } },
        }]);
        expect(diagnostics.get("lean:check")?.[0]).toMatchObject({ from: 8, to: 10 });
      });
    }
  }
  it("agrees for empty sources and empty blocks", () => {
    for (const source of ["", "// ```lean\n// ```\n"]) {
      expect(buildEmbeddedLeanDocument(source).doc).toBe(buildEmbeddedLeanDocumentFromSource(source));
    }
  });
});
