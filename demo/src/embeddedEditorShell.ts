import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import {
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
  const toggleExpanded = StateEffect.define<string>();
  const closeAllExpanded = StateEffect.define<void>();
  const expandedState = StateField.define<Set<string>>({
    create() {
      return new Set();
    },
    update(value, transaction) {
      let next = value;
      for (const effect of transaction.effects) {
        if (effect.is(closeAllExpanded)) {
          next = new Set();
        } else if (effect.is(toggleExpanded)) {
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

  const adapterExtensions = new Map<AnyEmbeddedBlockEditorAdapter, Extension>();

  function createInlineHandle(
    outerView: EditorView,
    adapter: AnyEmbeddedBlockEditorAdapter,
    block: EmbeddedBlock,
  ): EmbeddedBlockInlineHandle {
    const container = document.createElement("div");
    container.className = "cm-embedded-block-inline";

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
      const view = options.currentView();
      if (view) {
        view.dispatch({ effects: closeAllExpanded.of(undefined) });
      }
    },
    extensionsFor(adapters) {
      return [
        expandedState,
        ...adapters.map((adapter) => {
          const cached = adapterExtensions.get(adapter);
          if (cached) {
            return cached;
          }
          const extension = [
            adapter.widgetExtension({
              buttonLabel(block, expanded) {
                return expanded
                  ? "Collapse editor"
                  : `Open ${adapter.widget.kindLabel(block)} editor`;
              },
              createExpanded(view, block) {
                return createInlineHandle(view, adapter, block);
              },
              description(block) {
                return adapter.widget.description(block);
              },
              expanded(state, block) {
                return state.field(expandedState).has(block.key);
              },
              kindLabel(block) {
                return adapter.widget.kindLabel(block);
              },
              onToggle(view, block) {
                view.dispatch({ effects: toggleExpanded.of(block.key) });
              },
              preview(code) {
                return adapter.widget.preview(code);
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
