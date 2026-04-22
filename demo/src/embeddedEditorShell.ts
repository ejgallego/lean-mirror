import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, WidgetType, type ViewUpdate } from "@codemirror/view";

import {
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

  class SourceToggleWidget extends WidgetType {
    constructor(private readonly block: EmbeddedBlock) {
      super();
    }

    override eq(other: SourceToggleWidget): boolean {
      return this.block.key === other.block.key;
    }

    override toDOM(view: EditorView): HTMLElement {
      const button = document.createElement("button");
      button.className = "cm-embedded-block-toggle cm-embedded-block-source-toggle";
      button.textContent = "Enable widget";
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: toggleBlock.of(this.block.key) });
        view.requestMeasure();
      });
      return button;
    }
  }

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
      return [
        disabledState,
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
          sourceWidget(block) {
            return new SourceToggleWidget(block);
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
                const shell = document.createElement("div");
                shell.className = "cm-embedded-block-widget-shell";
                const button = document.createElement("button");
                button.className = "cm-embedded-block-toggle";
                button.textContent = "Disable widget";
                button.type = "button";
                button.addEventListener("click", (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  view.dispatch({ effects: toggleBlock.of(block.key) });
                  view.requestMeasure();
                });

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
                shell.append(button, handle.dom);
                return {
                  destroy() {
                    trackedHandle.destroy();
                  },
                  dom: shell,
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
