import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { AnyEmbeddedBlockEditorAdapter, EmbeddedBlock } from "./embeddedBlocks.js";
import {
  createEmbeddedBlockModalController,
  embeddedBlockModalTheme,
  type EmbeddedBlockModalDom,
} from "./embeddedBlockModal.js";

export interface EmbeddedEditorShell {
  close(): void;
  extensionsFor(adapters: readonly AnyEmbeddedBlockEditorAdapter[]): Extension[];
}

export interface EmbeddedEditorShellOptions {
  currentUri(): string | null;
  currentView(): EditorView | null;
  dom: EmbeddedBlockModalDom;
  log(message: string): void;
  modalTheme?: () => Extension;
}

export function createEmbeddedEditorShell(
  options: EmbeddedEditorShellOptions,
): EmbeddedEditorShell {
  const controllers = new Map<AnyEmbeddedBlockEditorAdapter, { close(): void; extension: Extension }>();

  return {
    close() {
      for (const controller of controllers.values()) {
        controller.close();
      }
    },
    extensionsFor(adapters) {
      return adapters.map((adapter) => {
        const cached = controllers.get(adapter);
        if (cached) {
          return cached.extension;
        }
        const controller = createEmbeddedBlockModalController({
          adapter,
          currentUri: options.currentUri,
          currentView: options.currentView,
          dom: options.dom,
          log: options.log,
          modalTheme: options.modalTheme ?? embeddedBlockModalTheme,
        });
        const extension = adapter.widgetExtension((block) => {
          controller.open(block);
        });
        controllers.set(adapter, { close: controller.close, extension });
        return extension;
      });
    },
  };
}
