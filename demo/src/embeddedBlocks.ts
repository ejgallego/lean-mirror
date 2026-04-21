import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
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
  buttonLabel: string;
  defaultTitle(block: EmbeddedBlock): string;
  description: string;
  kind: string;
}

export interface EmbeddedBlockWidgetConfig<TBlock extends EmbeddedBlock> {
  buttonLabel: string;
  description(block: TBlock): string;
  kindLabel(block: TBlock): string;
  onOpen(block: TBlock): void;
  preview(code: string): string;
}

export interface EmbeddedBlockEditorAdapter<TBlock extends EmbeddedBlock> {
  editorExtensions(): Extension[];
  parse(source: string): TBlock[];
  serialize(block: TBlock, code: string): string;
  widgetExtension(onOpen: (block: TBlock) => void): Extension;
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

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embedded-block-widget";
    wrap.dataset.kind = this.config.kindLabel(this.block).toLowerCase();

    const badge = document.createElement("span");
    badge.className = "cm-embedded-block-badge";
    badge.textContent = this.config.kindLabel(this.block);

    const title = document.createElement("strong");
    title.className = "cm-embedded-block-title";
    title.textContent = this.block.title;

    const summary = document.createElement("p");
    summary.className = "cm-embedded-block-summary";
    summary.textContent = this.config.description(this.block);

    const code = document.createElement("pre");
    code.className = "cm-embedded-block-preview";
    code.textContent = this.config.preview(this.block.code);

    const button = document.createElement("button");
    button.className = "cm-embedded-block-open";
    button.type = "button";
    button.textContent = this.config.buttonLabel;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.config.onOpen(this.block);
    });

    wrap.append(badge, title, summary, code, button);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
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
    display: "grid",
    gap: "10px",
    margin: "10px 0",
    padding: "14px 16px",
    borderRadius: "14px",
    border: "1px solid #d6c69d",
    background:
      "linear-gradient(180deg, rgba(255,247,220,0.96) 0%, rgba(243,233,201,0.96) 100%)",
    boxShadow: "0 8px 18px rgba(78, 59, 20, 0.08)",
  },
  ".cm-embedded-block-badge": {
    width: "fit-content",
    padding: "4px 8px",
    borderRadius: "999px",
    backgroundColor: "#3f2e17",
    color: "#f7ecdb",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  ".cm-embedded-block-title": {
    color: "#3d2f14",
    fontSize: "15px",
  },
  ".cm-embedded-block-summary": {
    margin: 0,
    color: "#5f5137",
    fontSize: "13px",
  },
  ".cm-embedded-block-preview": {
    margin: 0,
    padding: "12px",
    borderRadius: "10px",
    overflow: "auto",
    backgroundColor: "#2f2417",
    color: "#f6ead7",
    fontFamily: "\"Iosevka Term\", \"IBM Plex Mono\", monospace",
    fontSize: "13px",
    lineHeight: "1.45",
  },
  ".cm-embedded-block-open": {
    width: "fit-content",
    border: "none",
    borderRadius: "999px",
    backgroundColor: "#a4471b",
    color: "#fff5eb",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "700",
    padding: "8px 14px",
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
      update(value, transaction) {
        if (!transaction.docChanged) {
          return value;
        }
        return decorationsFor(transaction.state.doc.toString(), config, parse);
      },
      provide(field) {
        return EditorView.decorations.from(field);
      },
    }),
  ];
}
