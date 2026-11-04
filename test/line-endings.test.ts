import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { detectLeanLineEnding, leanDocumentText } from "../src/index.js";

describe("Lean line endings", () => {
  it("chooses the majority ending like VS Code", () => {
    expect(detectLeanLineEnding("a\nb\n")).toBe("\n");
    expect(detectLeanLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLeanLineEnding("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectLeanLineEnding("a\r\nb\nc\n")).toBe("\n");
    // A tie is not a CR majority.
    expect(detectLeanLineEnding("a\r\nb\n")).toBe("\n");
    // Lone carriage returns count as CR endings and persist as CRLF.
    expect(detectLeanLineEnding("a\rb\r")).toBe("\r\n");
  });

  it("uses the fallback when the text has no line break", () => {
    expect(detectLeanLineEnding("")).toBe("\n");
    expect(detectLeanLineEnding("theorem t : True := trivial", "\r\n")).toBe("\r\n");
  });

  it("writes an edited CRLF document back with CRLF", () => {
    const original = "import Helper\r\n\r\ndef answer := 42\r\n";
    const state = EditorState.create({ doc: original });
    expect(leanDocumentText(state.doc, detectLeanLineEnding(original))).toBe(original);

    const edited = state.update({
      changes: { from: state.doc.length, insert: "#eval answer\n" },
    }).state;
    expect(leanDocumentText(edited.doc, "\r\n")).toBe(`${original}#eval answer\r\n`);
    // Mixed files are normalized to their majority ending.
    const mixed = EditorState.create({ doc: "a\r\nb\r\nc\nd" }).doc;
    expect(leanDocumentText(mixed, detectLeanLineEnding("a\r\nb\r\nc\nd"))).toBe("a\r\nb\r\nc\r\nd");
  });
});
