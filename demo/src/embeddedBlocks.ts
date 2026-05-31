import { EditorState, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface EmbeddedBlock {
  code: string;
  from: number;
  key: string;
  label: string | null;
  ordinal: number;
  title: string;
  to: number;
}

export interface VersoCommentSpec {
  defaultTitle(block: EmbeddedBlock): string;
  kind: string;
}

export interface EmbeddedBlockInlineHandle {
  destroy(): void;
  dom: HTMLElement;
  setDiagnostics?(diagnostics: readonly EmbeddedBlockDiagnostic[]): void;
  sync(code: string, title: string): void;
}

export interface EmbeddedBlockDiagnostic {
  from: number;
  message: string;
  severity?: "error" | "warning" | "info" | "hint";
  to: number;
}

export interface EmbeddedBlockInlineCreateOptions<TBlock extends EmbeddedBlock> {
  block: TBlock;
  log(message: string): void;
  outerView: EditorView;
  syncOuter(code: string): void;
}

export interface EmbeddedBlockWidgetConfig<TBlock extends EmbeddedBlock> {
  createInline(view: EditorView, block: TBlock): EmbeddedBlockInlineHandle | null;
  enabled(state: EditorState, block: TBlock): boolean;
}

export interface EmbeddedBlockEditorAdapter<TBlock extends EmbeddedBlock> {
  createInlineHandle?(options: EmbeddedBlockInlineCreateOptions<TBlock>): EmbeddedBlockInlineHandle;
  displayName?: string;
  hostLanguageIds?: readonly string[];
  kind: string;
  editorExtensions(): Extension[];
  parse(source: string): TBlock[];
  scaffold?: EmbeddedBlockScaffold<TBlock>;
  serialize(block: TBlock, code: string): string;
  widgetExtension(config: EmbeddedBlockWidgetConfig<TBlock>): Extension;
}

export type AnyEmbeddedBlockEditorAdapter = EmbeddedBlockEditorAdapter<any>;

export interface VersoCommentAdapterSpec<TBlock extends EmbeddedBlock> {
  defaultTitle(block: EmbeddedBlock): string;
  displayName?: string;
  editorExtensions(): Extension[];
  hostLanguageIds?: readonly string[];
  kind: string;
  scaffold?: EmbeddedBlockScaffold<TBlock>;
}

export interface EmbeddedBlockScaffold<TBlock extends EmbeddedBlock> {
  baseLabel: string;
  code(label: string): string;
  createBlock?(label: string): TBlock;
}

export interface LineCommentEmbeddedBlock extends EmbeddedBlock {
  codeLineStarts?: readonly number[];
  indent: string;
  linePrefix: string;
}

export interface LineCommentAdapterSpec<TBlock extends LineCommentEmbeddedBlock> {
  defaultTitle(block: EmbeddedBlock): string;
  displayName?: string;
  editorExtensions(): Extension[];
  hostLanguageIds?: readonly string[];
  kind: string;
  linePrefixes: readonly string[];
  preferredLinePrefix: string;
  scaffold?: EmbeddedBlockScaffold<TBlock>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isVersoCommentStart(line: string): boolean {
  return /^\s*(?:\/-!|\/--)\s*$/.test(line);
}

// Demo-side heuristic: treat standalone Lean doc comments with a single fenced block as embeddable.
export function parseVersoCommentBlocks(
  source: string,
  spec: Pick<VersoCommentSpec, "defaultTitle" | "kind">,
): EmbeddedBlock[] {
  const lines = source.split("\n");
  const blocks: EmbeddedBlock[] = [];
  let offset = 0;
  let ordinal = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const newlineSize = offset + line.length < source.length ? 1 : 0;
    const nextOffset = offset + line.length + newlineSize;
    if (!isVersoCommentStart(line)) {
      offset = nextOffset;
      continue;
    }

    const headerLine = lines[index + 1] ?? "";
    const header = new RegExp(`^\\s*\`\`\`${escapeRegExp(spec.kind)}(?:\\s+(.+))?\\s*$`).exec(headerLine);
    if (!header) {
      offset = nextOffset;
      continue;
    }

    const from = offset;
    const label = header[1]?.trim() || null;
    const codeLines: string[] = [];
    const headerNewlineSize = nextOffset + headerLine.length < source.length ? 1 : 0;
    let endOffset = nextOffset + headerLine.length + headerNewlineSize;
    let foundEnd = false;

    for (let inner = index + 2; inner < lines.length; inner += 1) {
      const innerLine = lines[inner] ?? "";
      const innerStart = endOffset;
      const innerNewlineSize = innerStart + innerLine.length < source.length ? 1 : 0;
      endOffset = innerStart + innerLine.length + innerNewlineSize;
      if (/^\s*```\s*$/.test(innerLine)) {
        const closingLine = lines[inner + 1] ?? "";
        const closingStart = endOffset;
        const closingNewlineSize = closingStart + closingLine.length < source.length ? 1 : 0;
        const closingEnd = closingStart + closingLine.length + closingNewlineSize;
        if (!/^\s*-\s*\/\s*$/.test(closingLine)) {
          break;
        }
        ordinal += 1;
        const block: EmbeddedBlock = {
          code: codeLines.join("\n"),
          from,
          key: label ? `${spec.kind}:${label}` : `${spec.kind}:${ordinal}`,
          label,
          ordinal,
          title: "",
          to: closingEnd,
        };
        block.title = spec.defaultTitle(block);
        blocks.push(block);
        index = inner + 1;
        foundEnd = true;
        endOffset = closingEnd;
        break;
      }
      codeLines.push(innerLine);
    }

    offset = foundEnd ? endOffset : nextOffset;
  }

  return blocks;
}

function lineEndOffset(source: string, lineStart: number, line: string): number {
  return lineStart + line.length + (lineStart + line.length < source.length ? 1 : 0);
}

function parseLineComment(
  line: string,
  prefixes: readonly string[],
): { content: string; contentOffset: number; indent: string; prefix: string } | null {
  const ordered = [...prefixes].sort((left, right) => right.length - left.length);
  for (const prefix of ordered) {
    const match = new RegExp(`^(\\s*)${escapeRegExp(prefix)}(\\s?)(.*)$`).exec(line);
    if (match) {
      const indent = match[1] ?? "";
      const padding = match[2] ?? "";
      return {
        content: match[3] ?? "",
        contentOffset: indent.length + prefix.length + padding.length,
        indent,
        prefix,
      };
    }
  }
  return null;
}

export function parseLineCommentFencedBlocks<TBlock extends LineCommentEmbeddedBlock = LineCommentEmbeddedBlock>(
  source: string,
  spec: Pick<LineCommentAdapterSpec<TBlock>, "defaultTitle" | "kind" | "linePrefixes">,
): TBlock[] {
  const lines = source.split("\n");
  const blocks: TBlock[] = [];
  let ordinal = 0;
  let offset = 0;
  const headerPattern = new RegExp(`^\`\`\`${escapeRegExp(spec.kind)}(?:\\s+(.+))?\\s*$`);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextOffset = lineEndOffset(source, offset, line);
    const parsed = parseLineComment(line, spec.linePrefixes);
    if (!parsed) {
      offset = nextOffset;
      continue;
    }
    const header = headerPattern.exec(parsed.content);
    if (!header) {
      offset = nextOffset;
      continue;
    }

    const from = offset;
    const label = header[1]?.trim() || null;
    const codeLines: string[] = [];
    const codeLineStarts: number[] = [];
    let endOffset = nextOffset;
    let foundEnd = false;

    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner] ?? "";
      const innerStart = endOffset;
      endOffset = lineEndOffset(source, innerStart, innerLine);
      const innerParsed = parseLineComment(innerLine, spec.linePrefixes);
      if (!innerParsed) {
        break;
      }
      if (/^```\s*$/.test(innerParsed.content)) {
        ordinal += 1;
        const block = {
          code: codeLines.join("\n"),
          from,
          indent: parsed.indent,
          key: label ? `${spec.kind}:${label}` : `${spec.kind}:${ordinal}`,
          label,
          linePrefix: parsed.prefix,
          ordinal,
          title: "",
          to: endOffset,
        } as TBlock;
        block.title = spec.defaultTitle(block);
        blocks.push(block);
        index = inner;
        foundEnd = true;
        offset = endOffset;
        break;
      }
      codeLineStarts.push(innerStart + innerParsed.contentOffset);
      codeLines.push(innerParsed.content);
    }

    if (!foundEnd) {
      offset = nextOffset;
      continue;
    }
  }

  return blocks;
}

export function serializeVersoCommentBlock(
  block: EmbeddedBlock,
  kind: string,
  code: string,
): string {
  return [
    "/-!",
    `\`\`\`${kind}${block.label ? ` ${block.label}` : ""}`,
    code,
    "```",
    "-/",
  ].join("\n") + "\n";
}

export function serializeLineCommentFencedBlock(
  block: Partial<LineCommentEmbeddedBlock> & Pick<EmbeddedBlock, "label">,
  kind: string,
  code: string,
  fallbackPrefix = "//",
): string {
  const indent = block.indent ?? "";
  const prefix = block.linePrefix ?? fallbackPrefix;
  const commentLine = (content: string): string =>
    content.length > 0 ? `${indent}${prefix} ${content}` : `${indent}${prefix}`;
  return [
    commentLine(`\`\`\`${kind}${block.label ? ` ${block.label}` : ""}`),
    ...code.split("\n").map(commentLine),
    commentLine("```"),
  ].join("\n") + "\n";
}

export function findEmbeddedBlockByKey<TBlock extends EmbeddedBlock>(
  source: string,
  key: string,
  parse: (source: string) => TBlock[],
): TBlock | null {
  return parse(source).find((block) => block.key === key) ?? null;
}

export function collectEmbeddedBlocks(
  source: string,
  adapters: readonly AnyEmbeddedBlockEditorAdapter[],
): EmbeddedBlock[] {
  return adapters
    .flatMap((adapter) => adapter.parse(source))
    .sort((left, right) => left.from - right.from || left.to - right.to);
}

export class EmbeddedBlockWidget<TBlock extends EmbeddedBlock> extends WidgetType {
  constructor(
    readonly block: TBlock,
    private readonly config: EmbeddedBlockWidgetConfig<TBlock>,
  ) {
    super();
  }

  override eq(other: EmbeddedBlockWidget<TBlock>): boolean {
    return this.block.key === other.block.key;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embedded-block-widget";
    const handle = this.config.createInline(view, this.block);
    if (handle) {
      wrap.append(handle.dom);
      (wrap as unknown as { __embeddedHandle?: EmbeddedBlockInlineHandle }).__embeddedHandle =
        handle;
    }

    return wrap;
  }

  override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const handle = (dom as unknown as { __embeddedHandle?: EmbeddedBlockInlineHandle })
      .__embeddedHandle;
    if (!handle) {
      return false;
    }
    handle.sync(this.block.code, this.block.title);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override destroy(dom: HTMLElement): void {
    const handle = (dom as unknown as { __embeddedHandle?: EmbeddedBlockInlineHandle })
      .__embeddedHandle;
    handle?.destroy();
  }
}

function decorationsFor<TBlock extends EmbeddedBlock>(
  source: string,
  state: EditorState,
  config: EmbeddedBlockWidgetConfig<TBlock>,
  parse: (source: string) => TBlock[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of parse(source)) {
    if (!config.enabled(state, block)) {
      continue;
    }
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        block: true,
        widget: new EmbeddedBlockWidget(block, config),
      }),
    );
  }
  return builder.finish();
}

export const embeddedBlockTheme = EditorView.baseTheme({
  ".cm-embedded-block-widget": {
    margin: "4px 0",
  },
  ".cm-embedded-block-gutter": {
    width: "46px",
  },
  ".cm-embedded-block-gutter .cm-gutterElement": {
    display: "flex",
    justifyContent: "center",
    padding: "0 6px",
  },
  ".cm-embedded-gutter-action": {
    width: "30px",
    height: "30px",
    border: "1px solid rgba(61, 47, 20, 0.14)",
    borderRadius: "999px",
    background: "rgba(255, 251, 243, 0.92)",
    color: "#5e4e32",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    font: "inherit",
    padding: "0",
    boxShadow: "0 2px 8px rgba(92, 63, 18, 0.08)",
    transition:
      "opacity 120ms ease, transform 140ms ease, background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease",
  },
  ".cm-embedded-gutter-icon": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  },
  ".cm-embedded-gutter-logo": {
    width: "19px",
    height: "19px",
    display: "block",
  },
  ".cm-embedded-gutter-toggle[data-state=\"enabled\"]": {
    background: "rgba(69, 53, 28, 0.94)",
    borderColor: "rgba(69, 53, 28, 0.98)",
    color: "#fbf4e5",
    boxShadow: "0 3px 10px rgba(54, 41, 20, 0.22)",
  },
  ".cm-embedded-gutter-toggle[data-state=\"disabled\"]": {
    background: "rgba(255, 251, 243, 0.96)",
    color: "#5e4e32",
  },
  ".cm-embedded-gutter-add": {
    opacity: "0.38",
    background: "rgba(255, 249, 238, 0.72)",
    borderColor: "rgba(61, 47, 20, 0.08)",
    boxShadow: "none",
    transform: "scale(0.92)",
  },
  ".cm-embedded-block-gutter .cm-gutterElement:hover .cm-embedded-gutter-add, .cm-embedded-gutter-add:focus-visible": {
    opacity: "1",
    background: "rgba(255, 251, 243, 0.96)",
    borderColor: "rgba(61, 47, 20, 0.14)",
    boxShadow: "0 2px 8px rgba(92, 63, 18, 0.08)",
    transform: "scale(1)",
  },
  ".cm-embedded-gutter-spacer": {
    visibility: "hidden",
    width: "30px",
    height: "30px",
  },
  ".cm-embedded-block-inline": {
    position: "relative",
    zIndex: "1",
    borderRadius: "12px",
    border: "1px solid #d9cfbb",
    overflow: "visible",
    background:
      "linear-gradient(180deg, rgba(255,250,240,0.96) 0%, rgba(246,239,221,0.96) 100%)",
    boxShadow: "0 6px 16px rgba(78, 59, 20, 0.08)",
  },
  ".cm-embedded-block-inline .cm-editor": {
    minHeight: "0",
    border: "none",
    borderRadius: "0",
    overflow: "visible",
  },
  ".cm-embedded-block-inline .cm-scroller": {
    maxHeight: "min(32vh, 320px)",
    overflow: "auto",
  },
  ".cm-embedded-block-inline .cm-content": {
    minHeight: "0",
  },
  ".cm-embedded-block-inline .cm-tooltip": {
    zIndex: "90",
    maxHeight: "16rem",
    maxWidth: "36rem",
    overflow: "auto",
    overscrollBehavior: "contain",
  },
  ".cm-embedded-block-source": {
    backgroundColor: "rgba(210, 196, 160, 0.26)",
    borderRadius: "4px",
    color: "#6a5b3f",
  },
});

export function embeddedBlockWidgets<TBlock extends EmbeddedBlock>(
  parse: (source: string) => TBlock[],
  config: EmbeddedBlockWidgetConfig<TBlock>,
): Extension {
  return [
    embeddedBlockTheme,
    StateField.define<DecorationSet>({
      create(state) {
        return decorationsFor(state.doc.toString(), state, config, parse);
      },
      update(_value, transaction) {
        return decorationsFor(transaction.state.doc.toString(), transaction.state, config, parse);
      },
      provide(field) {
        return EditorView.decorations.from(field);
      },
    }),
  ];
}

export function createVersoCommentAdapter<TBlock extends EmbeddedBlock = EmbeddedBlock>(
  spec: VersoCommentAdapterSpec<TBlock>,
): EmbeddedBlockEditorAdapter<TBlock> & {
  parseBlocks(source: string): TBlock[];
  serializeBlock(block: TBlock, code: string): string;
} {
  const parseBlocks = (source: string): TBlock[] =>
    parseVersoCommentBlocks(source, {
      defaultTitle: spec.defaultTitle,
      kind: spec.kind,
    }) as TBlock[];

  const serializeBlock = (block: TBlock, code: string): string =>
    serializeVersoCommentBlock(block, spec.kind, code);

  return {
    ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
    ...(spec.hostLanguageIds === undefined ? {} : { hostLanguageIds: spec.hostLanguageIds }),
    ...(spec.scaffold === undefined ? {} : { scaffold: spec.scaffold }),
    kind: spec.kind,
    editorExtensions() {
      return spec.editorExtensions();
    },
    parse: parseBlocks,
    parseBlocks,
    serialize: serializeBlock,
    serializeBlock,
    widgetExtension(config) {
      return embeddedBlockWidgets(parseBlocks, config);
    },
  };
}

export function createLineCommentAdapter<TBlock extends LineCommentEmbeddedBlock = LineCommentEmbeddedBlock>(
  spec: LineCommentAdapterSpec<TBlock>,
): EmbeddedBlockEditorAdapter<TBlock> & {
  parseBlocks(source: string): TBlock[];
  serializeBlock(block: TBlock, code: string): string;
} {
  const parseBlocks = (source: string): TBlock[] =>
    parseLineCommentFencedBlocks(source, {
      defaultTitle: spec.defaultTitle,
      kind: spec.kind,
      linePrefixes: spec.linePrefixes,
    });

  const serializeBlock = (block: TBlock, code: string): string =>
    serializeLineCommentFencedBlock(block, spec.kind, code, spec.preferredLinePrefix);

  return {
    ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
    ...(spec.hostLanguageIds === undefined ? {} : { hostLanguageIds: spec.hostLanguageIds }),
    ...(spec.scaffold === undefined ? {} : { scaffold: spec.scaffold }),
    kind: spec.kind,
    editorExtensions() {
      return spec.editorExtensions();
    },
    parse: parseBlocks,
    parseBlocks,
    serialize: serializeBlock,
    serializeBlock,
    widgetExtension(config) {
      return embeddedBlockWidgets(parseBlocks, config);
    },
  };
}

export function embeddedBlockSourceMode(
  adapters: readonly AnyEmbeddedBlockEditorAdapter[],
  options: {
    disabled(state: EditorState, block: EmbeddedBlock): boolean;
  },
): Extension {
  return [
    embeddedBlockTheme,
    StateField.define<DecorationSet>({
      create(state) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const block of collectEmbeddedBlocks(state.doc.toString(), adapters)) {
          if (!options.disabled(state, block)) {
            continue;
          }
          builder.add(
            block.from,
            block.to,
            Decoration.mark({ class: "cm-embedded-block-source" }),
          );
        }
        return builder.finish();
      },
      update(_value, transaction) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const block of collectEmbeddedBlocks(transaction.state.doc.toString(), adapters)) {
          if (!options.disabled(transaction.state, block)) {
            continue;
          }
          builder.add(
            block.from,
            block.to,
            Decoration.mark({ class: "cm-embedded-block-source" }),
          );
        }
        return builder.finish();
      },
      provide(field) {
        return EditorView.decorations.from(field);
      },
    }),
    EditorState.changeFilter.of((transaction) => {
      if (!transaction.docChanged) {
        return true;
      }
      return collectEmbeddedBlocks(transaction.startState.doc.toString(), adapters)
        .filter((block) => options.disabled(transaction.startState, block))
        .flatMap((block) => [block.from, block.to]);
    }),
  ];
}
