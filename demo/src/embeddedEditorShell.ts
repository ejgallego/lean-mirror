import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { EmbeddedBlock, EmbeddedBlockEditorAdapter } from "./embeddedBlocks.js";
import {
  createEmbeddedBlockModalController,
  embeddedBlockModalTheme,
  type EmbeddedBlockModalDom,
} from "./embeddedBlockModal.js";

export interface EmbeddedEditorShell {
  close(): void;
  extensionFor<TBlock extends EmbeddedBlock>(adapter: EmbeddedBlockEditorAdapter<TBlock>): Extension;
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
  const controllers: Array<{ close(): void }> = [];

  return {
    close() {
      for (const controller of controllers) {
        controller.close();
      }
    },
    extensionFor<TBlock extends EmbeddedBlock>(adapter: EmbeddedBlockEditorAdapter<TBlock>): Extension {
      const controller = createEmbeddedBlockModalController({
        adapter,
        currentUri: options.currentUri,
        currentView: options.currentView,
        dom: options.dom,
        log: options.log,
        modalTheme: options.modalTheme ?? embeddedBlockModalTheme,
      });
      controllers.push(controller);
      return adapter.widgetExtension((block) => {
        controller.open(block);
      });
    },
  };
}
