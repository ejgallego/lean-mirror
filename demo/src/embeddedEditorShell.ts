import { EditorState, StateEffect, type Extension } from "@codemirror/state";
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
  const adapterExtensions = new Map<AnyEmbeddedBlockEditorAdapter, Extension>();

  function createInlineHandle(
    outerView: EditorView,
    adapter: AnyEmbeddedBlockEditorAdapter,
    block: EmbeddedBlock,
  ): EmbeddedBlockInlineHandle {
    if (adapter.createInlineHandle) {
      return adapter.createInlineHandle({
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
    }

    const container = document.createElement("div");
    container.className = "cm-embedded-block-inline";
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
      container.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }

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
    close() {},
    extensionsFor(adapters) {
      return adapters.map((adapter) => {
          const cached = adapterExtensions.get(adapter);
          if (cached) {
            return cached;
          }
          const extension = [
            adapter.widgetExtension({
              createInline(view, block) {
                return createInlineHandle(view, adapter, block);
              },
            }),
          ];
          adapterExtensions.set(adapter, extension);
          return extension;
        });
    },
  };
}
