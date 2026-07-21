import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";

import {
  leanFallbackHighlightStyle,
  leanFallbackLanguage,
  leanFallbackLanguageSupport,
} from "../src/index.js";

interface HighlightedToken {
  classes: string;
  text: string;
}

function highlighted(source: string): HighlightedToken[] {
  const tokens: HighlightedToken[] = [];
  highlightTree(leanFallbackLanguage.parser.parse(source), classHighlighter, (from, to, classes) => {
    tokens.push({ classes, text: source.slice(from, to) });
  });
  return tokens;
}

function classesFor(source: string, text: string): string {
  return highlighted(source).find((token) => token.text === text)?.classes ?? "";
}

describe("Lean fallback tokenizer", () => {
  it("classifies representative commands, keywords, types, directives, and literals", () => {
    const source = [
      "unsafe def answer : Nat := 0x2a",
      "#check fun α : Type => α",
      'example : String := "Lean\\n4"',
    ].join("\n");

    expect(classesFor(source, "unsafe")).toContain("tok-keyword");
    expect(classesFor(source, "def")).toContain("tok-keyword");
    expect(classesFor(source, "fun")).toContain("tok-keyword");
    expect(classesFor(source, "Nat")).toContain("tok-typeName");
    expect(classesFor(source, "#check")).toContain("tok-meta");
    expect(classesFor(source, "0x2a")).toContain("tok-number");
    expect(classesFor(source, '"Lean\\n4"')).toContain("tok-string");
  });

  it("tracks nested block comments across lines", () => {
    const source = "/- outer\n  /- nested -/\n  done -/\ndef visible := true";
    const tokens = highlighted(source);
    const comments = tokens.filter((token) => token.classes.includes("tok-comment"));

    expect(comments.map((token) => token.text).join("\n")).toContain("nested");
    expect(classesFor(source, "def")).toContain("tok-keyword");
  });

  it("keeps the host-selected highlighting theme optional", () => {
    expect(leanFallbackLanguageSupport().support).toHaveLength(3);
    expect(
      leanFallbackLanguageSupport({ highlightStyle: leanFallbackHighlightStyle }).support,
    ).toHaveLength(4);
  });
});
