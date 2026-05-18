import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, WidgetType, gutter, type BlockInfo, type ViewUpdate } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";

import {
  EmbeddedBlockWidget,
  collectEmbeddedBlocks,
  embeddedBlockSourceMode,
  findEmbeddedBlockByKey,
  type AnyEmbeddedBlockEditorAdapter,
  type EmbeddedBlock,
  type EmbeddedBlockDiagnostic,
  type EmbeddedBlockInlineHandle,
} from "./embeddedBlocks.js";

export interface EmbeddedEditorShell {
  close(): void;
  extensionsFor(adapters: readonly AnyEmbeddedBlockEditorAdapter[]): Extension[];
  setDiagnostics(kind: string, diagnostics: ReadonlyMap<string, readonly EmbeddedBlockDiagnostic[]>): void;
}

export interface EmbeddedEditorShellOptions {
  currentLanguageId?(): string | null;
  currentUri(): string | null;
  currentView(): EditorView | null;
  log(message: string): void;
}

export function createEmbeddedEditorShell(
  options: EmbeddedEditorShellOptions,
): EmbeddedEditorShell {
  const adapterExtensions = new Map<AnyEmbeddedBlockEditorAdapter, Extension>();
  const activeHandles = new Map<
    string,
    { adapter: AnyEmbeddedBlockEditorAdapter; handle: EmbeddedBlockInlineHandle }
  >();
  const toggleBlock = StateEffect.define<string>();
  const disabledState = StateField.define<Set<string>>({
    create() {
      return new Set();
    },
    update(value, transaction) {
      let next = value;
      for (const effect of transaction.effects) {
        if (effect.is(toggleBlock)) {
          next = new Set(next);
          if (next.has(effect.value)) {
            next.delete(effect.value);
          } else {
            next.add(effect.value);
          }
        }
      }
      return next;
    },
  });
  const blocksState = StateField.define<EmbeddedBlock[]>({
    create(state) {
      return collectEmbeddedBlocks(state.doc.toString(), adaptersRef);
    },
    update(value, transaction) {
      return transaction.docChanged
        ? collectEmbeddedBlocks(transaction.state.doc.toString(), adaptersRef)
        : value;
    },
  });

  function isolatePointerEvents(dom: HTMLElement): void {
    for (const eventName of [
      "mouseenter",
      "mouseleave",
      "mousemove",
      "mouseover",
      "mouseout",
      "pointerenter",
      "pointerleave",
      "pointermove",
      "pointerover",
      "pointerout",
    ]) {
      dom.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }
  }

  function createLanguageIcon(adapter: AnyEmbeddedBlockEditorAdapter): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "cm-embedded-gutter-logo");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");

    if (adapter.kind === "lean") {
      const frame = document.createElementNS(ns, "rect");
      frame.setAttribute("x", "12");
      frame.setAttribute("y", "10");
      frame.setAttribute("width", "40");
      frame.setAttribute("height", "44");
      frame.setAttribute("rx", "8");
      frame.setAttribute("fill", "none");
      frame.setAttribute("stroke", "currentColor");
      frame.setAttribute("stroke-width", "4");
      svg.append(frame);

      const lambda = document.createElementNS(ns, "text");
      lambda.setAttribute("x", "32");
      lambda.setAttribute("y", "43");
      lambda.setAttribute("fill", "currentColor");
      lambda.setAttribute("font-family", "Iosevka Term, IBM Plex Mono, monospace");
      lambda.setAttribute("font-size", "34");
      lambda.setAttribute("font-weight", "700");
      lambda.setAttribute("text-anchor", "middle");
      lambda.textContent = "λ";
      svg.append(lambda);

      return svg;
    }

    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("cx", "32");
    ring.setAttribute("cy", "32");
    ring.setAttribute("r", "18");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "currentColor");
    ring.setAttribute("stroke-width", "3.5");
    svg.append(ring);

    for (let angle = 0; angle < 360; angle += 45) {
      const tooth = document.createElementNS(ns, "rect");
      tooth.setAttribute("x", "29");
      tooth.setAttribute("y", "1.5");
      tooth.setAttribute("width", "6");
      tooth.setAttribute("height", "10");
      tooth.setAttribute("rx", "1.5");
      tooth.setAttribute("fill", "currentColor");
      tooth.setAttribute("transform", `rotate(${angle} 32 32)`);
      svg.append(tooth);
    }

    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", "32");
    text.setAttribute("y", "40");
    text.setAttribute("fill", "currentColor");
    text.setAttribute("font-family", "Iosevka Term, IBM Plex Mono, monospace");
    text.setAttribute("font-size", "24");
    text.setAttribute("font-weight", "700");
    text.setAttribute("text-anchor", "middle");
    text.textContent = (adapter.displayName ?? adapter.kind).trim().charAt(0).toUpperCase();
    svg.append(text);

    return svg;
  }

  function createGutterButton(
    adapter: AnyEmbeddedBlockEditorAdapter,
    label: string,
    className: string,
    title: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `cm-embedded-gutter-action ${className}`;
    button.setAttribute("aria-label", label);
    button.title = title;
    button.type = "button";

    const icon = document.createElement("span");
    icon.className = "cm-embedded-gutter-icon";
    icon.append(createLanguageIcon(adapter));

    button.append(icon);
    return button;
  }

  function adapterAvailableInCurrentDocument(adapter: AnyEmbeddedBlockEditorAdapter): boolean {
    const languageId = options.currentLanguageId?.() ?? null;
    if (!adapter.hostLanguageIds || !languageId) {
      return true;
    }
    return adapter.hostLanguageIds.includes(languageId);
  }

  function scaffoldAdapter(): AnyEmbeddedBlockEditorAdapter | null {
    return adaptersRef.find((adapter) => adapter.scaffold && adapterAvailableInCurrentDocument(adapter)) ?? null;
  }

  function nextScaffoldLabel(source: string, adapter: AnyEmbeddedBlockEditorAdapter): string {
    const scaffold = adapter.scaffold;
    if (!scaffold) {
      return adapter.kind;
    }
    const blocks = collectEmbeddedBlocks(source, adaptersRef).filter((block) =>
      block.key.startsWith(`${adapter.kind}:`),
    );
    const labels = new Set(blocks.map((block) => block.label).filter((label): label is string => !!label));
    const base = scaffold.baseLabel;
    if (!labels.has(base)) {
      return base;
    }
    let index = 2;
    for (;;) {
      const label = `${base}-${index}`;
      if (!labels.has(label)) {
        return label;
      }
      index += 1;
    }
  }

  function indentLines(text: string, indent: string): string {
    if (indent.length === 0) {
      return text;
    }
    return text
      .split("\n")
      .map((line) => (line.length === 0 ? line : `${indent}${line}`))
      .join("\n");
  }

  function insertScaffold(view: EditorView, lineFrom: number, adapter: AnyEmbeddedBlockEditorAdapter): void {
    const scaffoldSpec = adapter.scaffold;
    if (!scaffoldSpec) {
      return;
    }
    const source = view.state.doc.toString();
    const label = nextScaffoldLabel(source, adapter);
    const line = view.state.doc.lineAt(lineFrom);
    const indent = (/^\s*/.exec(line.text)?.[0]) ?? "";
    const scaffoldBlock: EmbeddedBlock = scaffoldSpec.createBlock?.(label) ?? {
      code: "",
      from: line.from,
      key: `${adapter.kind}:${label}`,
      label,
      ordinal: 0,
      title: label,
      to: line.from,
    };
    const scaffoldCode = scaffoldSpec.code(label);
    const scaffold = indentLines(adapter.serialize(scaffoldBlock, scaffoldCode), indent);
    view.dispatch({
      changes: {
        from: line.from,
        insert: `${scaffold}${line.length === 0 ? "" : "\n"}`,
        to: line.from,
      },
    });
    view.requestMeasure();
    options.log(`Inserted ${adapter.displayName ?? adapter.kind} scaffold ${label}`);
  }

  function lineBlockInfo(
    state: EditorState,
    line: BlockInfo,
  ): { block: EmbeddedBlock | null; kind: "block-start" | "block-body" | "outside" } {
    const blocks = state.field(blocksState);
    for (const block of blocks) {
      const startLine = state.doc.lineAt(block.from);
      const endLine = state.doc.lineAt(Math.max(block.from, block.to - 1));
      if (line.from < startLine.from || line.from > endLine.from) {
        continue;
      }
      if (line.from === startLine.from) {
        return { block, kind: "block-start" };
      }
      return { block, kind: "block-body" };
    }
    return { block: null, kind: "outside" };
  }

  class ToggleBlockMarker extends GutterMarker {
    constructor(
      private readonly blockKey: string,
      private readonly disabled: boolean,
    ) {
      super();
    }

    override eq(other: ToggleBlockMarker): boolean {
      return this.blockKey === other.blockKey && this.disabled === other.disabled;
    }

    override toDOM(view: EditorView): HTMLElement {
      const adapter = adaptersRef.find((candidate) => this.blockKey.startsWith(`${candidate.kind}:`)) ?? adaptersRef[0];
      if (!adapter) {
        return document.createElement("span");
      }
      const button = createGutterButton(
        adapter,
        this.disabled ? "Enable widget" : "Disable widget",
        "cm-embedded-gutter-toggle",
        this.disabled ? "Enable embedded widget" : "Disable embedded widget",
      );
      button.dataset.state = this.disabled ? "disabled" : "enabled";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: toggleBlock.of(this.blockKey) });
        view.requestMeasure();
      });
      return button;
    }
  }

  class AddBlockMarker extends GutterMarker {
    constructor(
      private readonly adapter: AnyEmbeddedBlockEditorAdapter,
      private readonly lineFrom: number,
    ) {
      super();
    }

    override eq(other: AddBlockMarker): boolean {
      return this.adapter.kind === other.adapter.kind && this.lineFrom === other.lineFrom;
    }

    override toDOM(view: EditorView): HTMLElement {
      const name = this.adapter.displayName ?? this.adapter.kind;
      const button = createGutterButton(
        this.adapter,
        `Add ${name}`,
        "cm-embedded-gutter-add",
        `Insert ${name} code scaffold`,
      );
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        insertScaffold(view, this.lineFrom, this.adapter);
      });
      return button;
    }
  }

  class EmbeddedGutterSpacer extends GutterMarker {
    override toDOM(): HTMLElement {
      const spacer = document.createElement("div");
      spacer.className = "cm-embedded-gutter-spacer";
      spacer.textContent = "Disable widget";
      return spacer;
    }
  }

  const adaptersRef: AnyEmbeddedBlockEditorAdapter[] = [];

  function createInlineHandle(
    outerView: EditorView,
    adapter: AnyEmbeddedBlockEditorAdapter,
    block: EmbeddedBlock,
  ): EmbeddedBlockInlineHandle {
    if (adapter.createInlineHandle) {
      const handle = adapter.createInlineHandle({
        block,
        log(message) {
          options.log(message);
        },
        outerView,
        syncOuter(code) {
          const target = findEmbeddedBlockByKey(
            outerView.state.doc.toString(),
            block.key,
            adapter.parse,
          );
          if (!target) {
            return;
          }
          outerView.dispatch({
            changes: {
              from: target.from,
              insert: adapter.serialize(target, code),
              to: target.to,
            },
          });
        },
      });
      isolatePointerEvents(handle.dom);
      return handle;
    }

    const container = document.createElement("div");
    container.className = "cm-embedded-block-inline";
    isolatePointerEvents(container);

    let syncingFromOuter = false;
    const nestedView = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: block.code,
        extensions: adapter.editorExtensions(),
      }),
    });

    const innerSyncExtension = EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged || syncingFromOuter) {
        return;
      }
      const target = findEmbeddedBlockByKey(
        outerView.state.doc.toString(),
        block.key,
        adapter.parse,
      );
      if (!target) {
        return;
      }
      options.log(`Expanded embedded block ${block.title}`);
      outerView.dispatch({
        changes: {
          from: target.from,
          insert: adapter.serialize(target, update.state.doc.toString()),
          to: target.to,
        },
      });
    });
    nestedView.dispatch({
      effects: StateEffect.appendConfig.of(innerSyncExtension),
    });

    options.log(`Expanded embedded block ${block.title}`);

    return {
      destroy() {
        nestedView.destroy();
      },
      dom: container,
      setDiagnostics(diagnostics) {
        nestedView.dispatch(
          setDiagnostics(
            nestedView.state,
            diagnostics.map((diagnostic) => ({
              from: Math.max(0, Math.min(nestedView.state.doc.length, diagnostic.from)),
              message: diagnostic.message,
              severity: diagnostic.severity ?? "error",
              to: Math.max(0, Math.min(nestedView.state.doc.length, diagnostic.to)),
            })),
          ),
        );
      },
      sync(code: string) {
        if (nestedView.state.doc.toString() === code) {
          return;
        }
        syncingFromOuter = true;
        try {
          nestedView.dispatch({
            changes: {
              from: 0,
              insert: code,
              to: nestedView.state.doc.length,
            },
          });
        } finally {
          syncingFromOuter = false;
        }
      },
    };
  }

  return {
    close() {
      for (const { handle } of activeHandles.values()) {
        handle.destroy();
      }
      activeHandles.clear();
    },
    extensionsFor(adapters) {
      adaptersRef.splice(0, adaptersRef.length, ...adapters);
      return [
        blocksState,
        disabledState,
        gutter({
          class: "cm-embedded-block-gutter",
          initialSpacer() {
            return new EmbeddedGutterSpacer();
          },
          lineMarker(view, line) {
            const info = lineBlockInfo(view.state, line);
            if (info.kind === "block-start" && info.block) {
              if (view.state.field(disabledState).has(info.block.key)) {
                return new ToggleBlockMarker(info.block.key, true);
              }
              return null;
            }
            if (info.kind === "outside") {
              const adapter = scaffoldAdapter();
              return adapter ? new AddBlockMarker(adapter, line.from) : null;
            }
            return null;
          },
          widgetMarker(view, widget) {
            if (!(widget instanceof EmbeddedBlockWidget)) {
              return null;
            }
            return new ToggleBlockMarker(
              widget.block.key,
              view.state.field(disabledState).has(widget.block.key),
            );
          },
          lineMarkerChange(update) {
            return update.docChanged || update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(toggleBlock)),
            );
          },
        }),
        EditorView.updateListener.of((update) => {
          const toggled = update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(toggleBlock)),
          );
          if (toggled) {
            update.view.requestMeasure();
            setTimeout(() => {
              update.view.requestMeasure();
            }, 0);
          }
          if (!update.docChanged) {
            return;
          }
          const blocks = update.state.field(blocksState);
          for (const [key, entry] of activeHandles) {
            const block = blocks.find((candidate) => candidate.key === key);
            if (!block) {
              continue;
            }
            entry.handle.sync(block.code, block.title);
          }
        }),
        embeddedBlockSourceMode(adapters, {
          disabled(state, block) {
            return state.field(disabledState).has(block.key);
          },
        }),
        ...adapters.map((adapter) => {
          const cached = adapterExtensions.get(adapter);
          if (cached) {
            return cached;
          }
          const extension = [
            adapter.widgetExtension({
              createInline(view, block) {
                const handle = createInlineHandle(view, adapter, block);
                let destroyed = false;
                const trackedHandle: EmbeddedBlockInlineHandle = {
                  destroy() {
                    if (destroyed) {
                      return;
                    }
                    destroyed = true;
                    const entry = activeHandles.get(block.key);
                    if (entry?.handle === trackedHandle) {
                      activeHandles.delete(block.key);
                    }
                    handle.destroy();
                  },
                  dom: handle.dom,
                  setDiagnostics(diagnostics) {
                    if (destroyed) {
                      return;
                    }
                    handle.setDiagnostics?.(diagnostics);
                  },
                  sync(code, title) {
                    if (destroyed) {
                      return;
                    }
                    handle.sync(code, title);
                  },
                };
                activeHandles.set(block.key, { adapter, handle: trackedHandle });
                return {
                  destroy() {
                    trackedHandle.destroy();
                  },
                  dom: handle.dom,
                  setDiagnostics(diagnostics) {
                    trackedHandle.setDiagnostics?.(diagnostics);
                  },
                  sync(code, title) {
                    trackedHandle.sync(code, title);
                  },
                };
              },
              enabled(state, block) {
                return !state.field(disabledState).has(block.key);
              },
            }),
          ];
          adapterExtensions.set(adapter, extension);
          return extension;
        }),
      ];
    },
    setDiagnostics(kind, diagnostics) {
      for (const [key, entry] of activeHandles) {
        if (entry.adapter.kind !== kind) {
          continue;
        }
        entry.handle.setDiagnostics?.(diagnostics.get(key) ?? []);
      }
    },
  };
}
