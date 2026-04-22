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

export interface CommentFenceSpec {
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

export interface CommentFencedAdapterSpec<TBlock extends EmbeddedBlock> {
  defaultTitle(block: EmbeddedBlock): string;
  editorExtensions(): Extension[];
  kind: string;
}

function uncommentLine(line: string): string {
  if (line === "--") {
    return "";
  }
  return line.replace(/^--\s?/, "");
}

export function parseCommentFencedBlocks(
  source: string,
  spec: Pick<CommentFenceSpec, "defaultTitle" | "kind">,
): EmbeddedBlock[] {
  const lines = source.split("\n");
  const blocks: EmbeddedBlock[] = [];
  let offset = 0;
  let ordinal = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const newlineSize = offset + line.length < source.length ? 1 : 0;
    const nextOffset = offset + line.length + newlineSize;
    const start = new RegExp(`^--\\s*\`\`\`${spec.kind}(?:\\s+(.+))?\\s*$`).exec(line);
    if (!start) {
      offset = nextOffset;
      continue;
    }

    const from = offset;
    const label = start[1]?.trim() || null;
    const codeLines: string[] = [];
    let endOffset = nextOffset;
    let foundEnd = false;

    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner] ?? "";
      const innerStart = endOffset;
      const innerNewlineSize = innerStart + innerLine.length < source.length ? 1 : 0;
      endOffset = innerStart + innerLine.length + innerNewlineSize;
      if (/^--\s*```\s*$/.test(innerLine)) {
        ordinal += 1;
        const block: EmbeddedBlock = {
          code: codeLines.join("\n"),
          from,
          key: label ? `${spec.kind}:${label}` : `${spec.kind}:${ordinal}`,
          label,
          ordinal,
          title: "",
          to: endOffset,
        };
        block.title = spec.defaultTitle(block);
        blocks.push(block);
        index = inner;
        foundEnd = true;
        break;
      }
      codeLines.push(uncommentLine(innerLine));
    }

    offset = foundEnd ? endOffset : nextOffset;
  }

  return blocks;
}

export function serializeCommentFencedBlock(
  block: EmbeddedBlock,
  kind: string,
  code: string,
): string {
  const header = `-- \`\`\`${kind}${block.label ? ` ${block.label}` : ""}`;
  const body = code.split("\n").map((line) => (line.length === 0 ? "--" : `-- ${line}`));
  return [header, ...body, "-- ```"].join("\n") + "\n";
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

function blockRanges(source: string, adapters: readonly AnyEmbeddedBlockEditorAdapter[]): number[] {
  return collectEmbeddedBlocks(source, adapters).flatMap((block) => [block.from, block.to]);
}

class EmbeddedBlockWidget<TBlock extends EmbeddedBlock> extends WidgetType {
  constructor(
    private readonly block: TBlock,
    private readonly config: EmbeddedBlockWidgetConfig<TBlock>,
  ) {
    super();
  }

  override eq(other: EmbeddedBlockWidget<TBlock>): boolean {
    return (
      this.block.key === other.block.key &&
      this.block.code === other.block.code &&
      this.block.title === other.block.title
    );
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
  config: EmbeddedBlockWidgetConfig<TBlock>,
  parse: (source: string) => TBlock[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of parse(source)) {
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
  ".cm-embedded-block-inline": {
    borderRadius: "12px",
    border: "1px solid #d9cfbb",
    overflow: "hidden",
    background:
      "linear-gradient(180deg, rgba(255,250,240,0.96) 0%, rgba(246,239,221,0.96) 100%)",
    boxShadow: "0 6px 16px rgba(78, 59, 20, 0.08)",
  },
  ".cm-embedded-block-inline .cm-editor": {
    minHeight: "180px",
    border: "none",
    borderRadius: "0",
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
        return decorationsFor(state.doc.toString(), config, parse);
      },
      update(_value, transaction) {
        return decorationsFor(transaction.state.doc.toString(), config, parse);
      },
      provide(field) {
        return EditorView.decorations.from(field);
      },
    }),
  ];
}

export function createCommentFencedAdapter<TBlock extends EmbeddedBlock = EmbeddedBlock>(
  spec: CommentFencedAdapterSpec<TBlock>,
): EmbeddedBlockEditorAdapter<TBlock> & {
  parseBlocks(source: string): TBlock[];
  serializeBlock(block: TBlock, code: string): string;
} {
  const parseBlocks = (source: string): TBlock[] =>
    parseCommentFencedBlocks(source, {
      defaultTitle: spec.defaultTitle,
      kind: spec.kind,
    }) as TBlock[];

  const serializeBlock = (block: TBlock, code: string): string =>
    serializeCommentFencedBlock(block, spec.kind, code);

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
): Extension {
  return [
    embeddedBlockTheme,
    StateField.define<DecorationSet>({
      create(state) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const block of collectEmbeddedBlocks(state.doc.toString(), adapters)) {
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
      return blockRanges(transaction.startState.doc.toString(), adapters);
    }),
  ];
}
