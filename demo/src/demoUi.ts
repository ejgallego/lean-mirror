import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  queryEmbeddedBlockModalDom,
  type EmbeddedBlockModalDom,
} from "./embeddedBlockModal.js";

export interface DemoUi {
  editorHost: HTMLDivElement;
  embeddedEditorDom: EmbeddedBlockModalDom;
  logEvent(text: string): void;
  renderDocumentButtons(
    documents: readonly string[],
    openDocument: (uri: string) => Promise<void>,
  ): void;
  setActiveDocument(uri: string): void;
  setCurrentDocument(uri: string): void;
  setRootUri(uri: string): void;
  setStatus(text: string): void;
}

export function demoTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "15px",
      backgroundColor: "#fffdf7",
    },
    ".cm-scroller": {
      fontFamily: "\"Iosevka Term\", \"IBM Plex Mono\", monospace",
      lineHeight: "1.5",
    },
    ".cm-content": {
      padding: "16px 0",
    },
    ".cm-gutters": {
      backgroundColor: "#f6f0df",
      color: "#6f6242",
      borderRight: "1px solid #e3d9c2",
    },
    ".cm-activeLine": {
      backgroundColor: "#fff5d9",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#f1e3b5",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "#d7e8ff",
    },
  });
}

export function queryDemoUi(root: ParentNode = document): DemoUi | null {
  const statusEl = root.querySelector<HTMLSpanElement>("#status");
  const rootUriEl = root.querySelector<HTMLElement>("#root-uri");
  const documentUriEl = root.querySelector<HTMLElement>("#document-uri");
  const eventsEl = root.querySelector<HTMLDivElement>("#events");
  const editorHost = root.querySelector<HTMLDivElement>("#editor");
  const documentsEl = root.querySelector<HTMLDivElement>("#documents");
  const embeddedEditorDom = queryEmbeddedBlockModalDom(root);

  if (
    !statusEl ||
    !rootUriEl ||
    !documentUriEl ||
    !eventsEl ||
    !editorHost ||
    !documentsEl ||
    !embeddedEditorDom
  ) {
    return null;
  }

  return {
    editorHost,
    embeddedEditorDom,
    logEvent(text: string) {
      const item = document.createElement("div");
      item.className = "event";
      item.textContent = text;
      eventsEl.prepend(item);
    },
    renderDocumentButtons(documents, openDocument) {
      documentsEl.replaceChildren();
      for (const uri of documents) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.uri = uri;
        button.textContent = uri.split("/").at(-1) ?? uri;
        button.addEventListener("click", () => {
          void openDocument(uri);
        });
        documentsEl.append(button);
      }
    },
    setActiveDocument(uri: string) {
      for (const button of documentsEl.querySelectorAll<HTMLButtonElement>("button")) {
        button.dataset.active = String(button.dataset.uri === uri);
      }
    },
    setCurrentDocument(uri: string) {
      documentUriEl.textContent = uri;
    },
    setRootUri(uri: string) {
      rootUriEl.textContent = uri;
    },
    setStatus(text: string) {
      statusEl.textContent = text;
    },
  };
}
