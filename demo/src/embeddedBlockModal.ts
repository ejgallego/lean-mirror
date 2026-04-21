import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  findEmbeddedBlockByKey,
  type EmbeddedBlock,
  type EmbeddedBlockEditorAdapter,
} from "./embeddedBlocks.js";

export interface EmbeddedBlockModalDom {
  closeButton: HTMLButtonElement;
  editorHost: HTMLDivElement;
  modal: HTMLDivElement;
  modalBackdrop: HTMLDivElement;
  title: HTMLHeadingElement;
}

export function queryEmbeddedBlockModalDom(root: ParentNode = document): EmbeddedBlockModalDom | null {
  const closeButton = root.querySelector<HTMLButtonElement>("#embedded-editor-close");
  const editorHost = root.querySelector<HTMLDivElement>("#embedded-editor-host");
  const modal = root.querySelector<HTMLDivElement>("#embedded-editor-modal");
  const modalBackdrop = root.querySelector<HTMLDivElement>("#embedded-editor-backdrop");
  const title = root.querySelector<HTMLHeadingElement>("#embedded-editor-title");

  if (!closeButton || !editorHost || !modal || !modalBackdrop || !title) {
    return null;
  }

  return {
    closeButton,
    editorHost,
    modal,
    modalBackdrop,
    title,
  };
}

export function embeddedBlockModalTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "#fffaf0",
    },
    ".cm-scroller": {
      fontFamily: "\"Iosevka Term\", \"IBM Plex Mono\", monospace",
      lineHeight: "1.5",
    },
    ".cm-gutters": {
      backgroundColor: "#f4ead2",
      borderRight: "1px solid #e0d3b2",
    },
  });
}

export interface EmbeddedBlockModalController<TBlock extends EmbeddedBlock> {
  close(): void;
  open(block: TBlock): void;
}

export interface EmbeddedBlockModalOptions<TBlock extends EmbeddedBlock> {
  adapter: EmbeddedBlockEditorAdapter<TBlock>;
  currentUri(): string | null;
  currentView(): EditorView | null;
  dom: EmbeddedBlockModalDom;
  log(message: string): void;
  modalTheme(): Extension;
}

export function createEmbeddedBlockModalController<TBlock extends EmbeddedBlock>(
  options: EmbeddedBlockModalOptions<TBlock>,
): EmbeddedBlockModalController<TBlock> {
  let embeddedView: EditorView | null = null;
  let activeBlock: { key: string; uri: string } | null = null;

  function currentSource(): string {
    return options.currentView()?.state.doc.toString() ?? "";
  }

  function close(): void {
    embeddedView?.destroy();
    embeddedView = null;
    activeBlock = null;
    options.dom.editorHost.replaceChildren();
    options.dom.modal.hidden = true;
  }

  function findActiveBlock(key: string): TBlock | null {
    return findEmbeddedBlockByKey(currentSource(), key, options.adapter.parse);
  }

  function open(block: TBlock): void {
    const hostView = options.currentView();
    const uri = options.currentUri();
    if (!hostView || !uri) {
      return;
    }
    const resolved = findActiveBlock(block.key) ?? block;
    activeBlock = { key: resolved.key, uri };
    options.dom.modal.hidden = false;
    options.dom.title.textContent = resolved.title;
    options.dom.editorHost.replaceChildren();
    embeddedView?.destroy();

    embeddedView = new EditorView({
      parent: options.dom.editorHost,
      state: EditorState.create({
        doc: resolved.code,
        extensions: [
          ...options.adapter.editorExtensions(),
          options.modalTheme(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || !activeBlock) {
              return;
            }
            const outerView = options.currentView();
            if (!outerView || activeBlock.uri !== options.currentUri()) {
              return;
            }
            const target = findActiveBlock(activeBlock.key);
            if (!target) {
              return;
            }
            outerView.dispatch({
              changes: {
                from: target.from,
                insert: options.adapter.serialize(target, update.state.doc.toString()),
                to: target.to,
              },
            });
          }),
        ],
      }),
    });

    options.log(`Opened embedded block ${resolved.title}`);
    embeddedView.focus();
  }

  options.dom.closeButton.addEventListener("click", close);
  options.dom.modalBackdrop.addEventListener("click", close);

  return { close, open };
}
