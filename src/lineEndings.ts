/**
 * Line endings a host can persist. CodeMirror documents always use `"\n"`
 * internally; serialize with `doc.sliceString(0, doc.length, lineEnding)`.
 */
export type LeanLineEnding = "\n" | "\r\n";

/**
 * Choose the line ending to write a document back with, following VS Code:
 * CRLF when carriage-return endings (`\r\n` or a lone `\r`) are more than half of
 * all line breaks, LF otherwise, and `fallback` when the text has no line break.
 * Mixed files are therefore normalized to their majority ending on save.
 *
 * Lean itself normalizes CRLF to LF and reports line/column positions that do not
 * depend on the ending, so the choice affects only what the host persists.
 */
export function detectLeanLineEnding(
  text: string,
  fallback: LeanLineEnding = "\n",
): LeanLineEnding {
  let carriageReturnEndings = 0;
  let lineBreaks = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      carriageReturnEndings++;
      lineBreaks++;
      if (text.charCodeAt(index + 1) === 10) index++;
    } else if (code === 10) {
      lineBreaks++;
    }
  }
  if (lineBreaks === 0) return fallback;
  return carriageReturnEndings > lineBreaks / 2 ? "\r\n" : "\n";
}
