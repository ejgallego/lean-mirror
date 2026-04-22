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
  sync(code: string, title: string): void;
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
  kind: string;
  editorExtensions(): Extension[];
  parse(source: string): TBlock[];
  serialize(block: TBlock, code: string): string;
  widgetExtension(config: EmbeddedBlockWidgetConfig<TBlock>): Extension;
}

export type AnyEmbeddedBlockEditorAdapter = EmbeddedBlockEditorAdapter<any>;

export interface VersoCommentAdapterSpec<TBlock extends EmbeddedBlock> {
  defaultTitle(block: EmbeddedBlock): string;
  editorExtensions(): Extension[];
  kind: string;
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
    const header = new RegExp(`^\\s*\`\`\`${spec.kind}(?:\\s+(.+))?\\s*$`).exec(headerLine);
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

class EmbeddedBlockWidget<TBlock extends EmbeddedBlock> extends WidgetType {
  constructor(
    private readonly block: TBlock,
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
  ".cm-embedded-block-widget-shell": {
    position: "relative",
  },
  ".cm-embedded-block-toggle": {
    border: "1px solid rgba(61, 47, 20, 0.14)",
    borderRadius: "999px",
    background: "rgba(255, 251, 243, 0.92)",
    color: "#5e4e32",
    cursor: "pointer",
    font: "inherit",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.04em",
    padding: "5px 9px",
  },
  ".cm-embedded-block-widget-shell > .cm-embedded-block-toggle": {
    position: "absolute",
    right: "10px",
    top: "10px",
    zIndex: "2",
  },
  ".cm-embedded-block-source-toggle": {
    position: "static",
    display: "inline-flex",
    alignItems: "center",
    margin: "6px 0 4px",
    width: "fit-content",
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
    minHeight: "180px",
    border: "none",
    borderRadius: "0",
    overflow: "visible",
  },
  ".cm-embedded-block-inline .cm-scroller": {
    overflow: "auto",
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
    sourceWidget(block: EmbeddedBlock): WidgetType;
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
            block.from,
            Decoration.widget({
              block: true,
              side: -1,
              widget: options.sourceWidget(block),
            }),
          );
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
            block.from,
            Decoration.widget({
              block: true,
              side: -1,
              widget: options.sourceWidget(block),
            }),
          );
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
