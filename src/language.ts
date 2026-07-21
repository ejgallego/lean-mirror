import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { keymap } from "@codemirror/view";
import { tags, type Highlighter } from "@lezer/highlight";

interface LeanTokenizerState {
  blockCommentDepth: number;
}

const COMMANDS = new Set([
  "abbrev",
  "alias",
  "axiom",
  "builtin_initialize",
  "class",
  "declare_syntax_cat",
  "def",
  "elab",
  "elab_rules",
  "example",
  "export",
  "inductive",
  "infix",
  "infixl",
  "infixr",
  "initialize",
  "instance",
  "macro",
  "macro_rules",
  "mutual",
  "namespace",
  "notation",
  "opaque",
  "open",
  "postfix",
  "prefix",
  "private",
  "scoped",
  "section",
  "set_option",
  "structure",
  "syntax",
  "theorem",
  "unsafe",
  "universe",
  "variable",
]);

const KEYWORDS = new Set([
  "as",
  "at",
  "attribute",
  "by",
  "case",
  "catch",
  "deriving",
  "do",
  "else",
  "end",
  "extends",
  "forall",
  "for",
  "from",
  "fun",
  "have",
  "if",
  "import",
  "in",
  "induction",
  "let",
  "match",
  "nomatch",
  "of",
  "partial",
  "renaming",
  "repeat",
  "return",
  "show",
  "simp",
  "termination_by",
  "then",
  "try",
  "unless",
  "using",
  "where",
  "while",
  "with",
  "yield",
]);

const BUILTINS = new Set(["Prop", "Type", "Sort", "True", "False"]);
const DIRECTIVE_PATTERN = /^#[\p{L}\p{N}_-]+/u;
const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_REST = /[\p{L}\p{N}_'.!?$]/u;
const OPERATOR_PATTERN =
  /^(?:[:=]+|[+\-/*%<>~^|&@]+|=>|->|←|↦|→|⟨|⟩|≤|≥|≠|⊢|∘|⋯|λ|∀|∃|:=)/u;

function readNestedBlockComment(stream: { eol(): boolean; match(pattern: string, consume?: boolean): boolean | RegExpMatchArray | null; next(): string | void; }, state: LeanTokenizerState): void {
  while (!stream.eol()) {
    if (stream.match("/-")) {
      state.blockCommentDepth += 1;
      continue;
    }
    if (stream.match("-/")) {
      state.blockCommentDepth -= 1;
      if (state.blockCommentDepth === 0) {
        return;
      }
      continue;
    }
    stream.next();
  }
}

function readString(stream: {
  eol(): boolean;
  next(): string | void;
}): void {
  stream.next();
  let escaped = false;
  while (!stream.eol()) {
    const ch = stream.next();
    if (typeof ch !== "string") {
      break;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      break;
    }
  }
}

function readIdentifier(stream: {
  eat(match: RegExp | string | ((ch: string) => boolean)): string | void;
  eatWhile(match: RegExp | string | ((ch: string) => boolean)): boolean;
  current(): string;
}): string {
  stream.eat(IDENTIFIER_START);
  stream.eatWhile(IDENTIFIER_REST);
  return stream.current();
}

export const leanFallbackHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#7d2c1f", fontWeight: "600" },
  { tag: [tags.definitionKeyword, tags.moduleKeyword], color: "#7d2c1f", fontWeight: "600" },
  { tag: tags.controlKeyword, color: "#5b2e91", fontWeight: "600" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6b7a52", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#126c53" },
  { tag: [tags.number, tags.bool], color: "#0f5e9c" },
  { tag: [tags.typeName, tags.namespace], color: "#1b4d8a" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "#4a4a4a" },
  { tag: tags.annotation, color: "#8d4c14" },
  { tag: tags.variableName, color: "#253238" },
]);

export const leanFallbackLanguage = StreamLanguage.define<LeanTokenizerState>({
  name: "lean4",
  startState() {
    return { blockCommentDepth: 0 };
  },
  token(stream, state) {
    if (state.blockCommentDepth > 0) {
      readNestedBlockComment(stream, state);
      return "blockComment";
    }
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match("--")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/-")) {
      state.blockCommentDepth = 1;
      readNestedBlockComment(stream, state);
      return "blockComment";
    }
    if (stream.peek() === "\"") {
      readString(stream);
      return "string";
    }
    if (stream.match(/^'(?:\\.|[^'\\])'/)) {
      return "string";
    }
    if (stream.match(/^0x[0-9a-fA-F]+/)) {
      return "number";
    }
    if (stream.match(/^\d+(?:\.\d+)?/)) {
      return "number";
    }
    if (stream.match(DIRECTIVE_PATTERN)) {
      return "annotation";
    }
    if (stream.match(OPERATOR_PATTERN)) {
      return "operator";
    }
    if (stream.match(/^[()[\]{};,]/)) {
      return "punctuation";
    }
    if (stream.peek() === "`") {
      stream.next();
      stream.eatWhile(IDENTIFIER_REST);
      return "variableName";
    }
    if (stream.eat(IDENTIFIER_START)) {
      stream.backUp(1);
      const identifier = readIdentifier(stream);
      if (COMMANDS.has(identifier)) {
        return "definitionKeyword";
      }
      if (KEYWORDS.has(identifier)) {
        return "keyword";
      }
      if (BUILTINS.has(identifier)) {
        return "typeName";
      }
      if (/^[A-Z]/.test(identifier)) {
        return "typeName";
      }
      return "variableName";
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "/-", close: "-/" } },
    closeBrackets: { brackets: ["(", "[", "{", "\""] },
    indentOnInput: /^\s*(?:end|else|in|where|\|)\b/,
    wordChars: "_'!?$",
  },
  tokenTable: {
    annotation: tags.annotation,
    blockComment: tags.blockComment,
    definitionKeyword: [tags.definitionKeyword, tags.keyword],
    lineComment: tags.lineComment,
    operator: tags.operator,
    punctuation: tags.punctuation,
  },
});

export interface LeanFallbackLanguageSupportOptions {
  highlightStyle?: Highlighter | false;
}

export function leanFallbackLanguageSupport(
  options: LeanFallbackLanguageSupportOptions = {},
): LanguageSupport {
  return new LanguageSupport(leanFallbackLanguage, [
    ...(options.highlightStyle ? [syntaxHighlighting(options.highlightStyle)] : []),
    bracketMatching(),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
  ]);
}
