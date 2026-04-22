import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, WidgetType, gutter, type BlockInfo, type ViewUpdate } from "@codemirror/view";

import {
  EmbeddedBlockWidget,
  collectEmbeddedBlocks,
  embeddedBlockSourceMode,
  findEmbeddedBlockByKey,
  type AnyEmbeddedBlockEditorAdapter,
  type EmbeddedBlock,
  type EmbeddedBlockInlineHandle,
} from "./embeddedBlocks.js";

export interface EmbeddedEditorShell {
  close(): void;
  extensionsFor(adapters: readonly AnyEmbeddedBlockEditorAdapter[]): Extension[];
}

export interface EmbeddedEditorShellOptions {
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

  function nextRustLabel(source: string): string {
    const blocks = collectEmbeddedBlocks(source, adaptersRef).filter((block) =>
      block.key.startsWith("rust:"),
    );
    const labels = new Set(blocks.map((block) => block.label).filter((label): label is string => !!label));
    const base = "demo-widget";
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

  function insertRustScaffold(view: EditorView, lineFrom: number): void {
    const adapter = adaptersRef.find((candidate) => candidate.kind === "rust");
    if (!adapter) {
      return;
    }
    const source = view.state.doc.toString();
    const label = nextRustLabel(source);
    const line = view.state.doc.lineAt(lineFrom);
    const indent = (/^\s*/.exec(line.text)?.[0]) ?? "";
    const scaffoldBlock: EmbeddedBlock = {
      code: "",
      from: line.from,
      key: `rust:${label}`,
      label,
      ordinal: 0,
      title: label,
      to: line.from,
    };
    const scaffoldCode = ['fn demo() {', '    println!("hello from Rust");', '}'].join("\n");
    const scaffold = indentLines(adapter.serialize(scaffoldBlock, scaffoldCode), indent);
    view.dispatch({
      changes: {
        from: line.from,
        insert: `${scaffold}${line.length === 0 ? "" : "\n"}`,
        to: line.from,
      },
    });
    view.requestMeasure();
    options.log(`Inserted Rust scaffold ${label}`);
  }

  function lineBlockInfo(
    state: EditorState,
    line: BlockInfo,
  ): { block: EmbeddedBlock | null; kind: "block-start" | "block-body" | "outside" } {
    const blocks = collectEmbeddedBlocks(state.doc.toString(), adaptersRef);
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
      const button = document.createElement("button");
      button.className = "cm-embedded-gutter-action cm-embedded-gutter-toggle";
      button.textContent = this.disabled ? "Enable widget" : "Disable widget";
      button.title = this.disabled ? "Enable Rust widget" : "Disable Rust widget";
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: toggleBlock.of(this.blockKey) });
        view.requestMeasure();
      });
      return button;
    }
  }

  class AddRustMarker extends GutterMarker {
    constructor(private readonly lineFrom: number) {
      super();
    }

    override eq(other: AddRustMarker): boolean {
      return this.lineFrom === other.lineFrom;
    }

    override toDOM(view: EditorView): HTMLElement {
      const button = document.createElement("button");
      button.className = "cm-embedded-gutter-action cm-embedded-gutter-add";
      button.textContent = "Add Rust";
      button.title = "Insert Rust code scaffold";
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        insertRustScaffold(view, this.lineFrom);
      });
      return button;
    }
  }

  class EmbeddedGutterSpacer extends GutterMarker {
    override toDOM(): HTMLElement {
      const spacer = document.createElement("div");
      spacer.className = "cm-embedded-gutter-spacer";
      spacer.textContent = "Add Rust";
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
              return new AddRustMarker(line.from);
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
          const source = update.state.doc.toString();
          for (const [key, entry] of activeHandles) {
            const block = findEmbeddedBlockByKey(source, key, entry.adapter.parse);
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
  };
}
