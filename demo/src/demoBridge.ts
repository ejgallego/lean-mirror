import type { EditorView } from "@codemirror/view";

export interface DemoBridge {
  install(openDocument: (uri: string) => Promise<void>): void;
}

declare global {
  interface Window {
    __leanDemo?: {
      currentUri(): string | null;
      currentDoc(): string | null;
      replaceCurrentText(search: string, replacement: string): boolean;
      setCursor(query: string): boolean;
      undo(): boolean;
      redo(): boolean;
      openDocument(uri: string): Promise<void>;
    };
  }
}

export interface DemoBridgeOptions {
  currentUri(): string | null;
  currentView(): EditorView | null;
  redo(): boolean;
  undo(): boolean;
}

export function createDemoBridge(options: DemoBridgeOptions): DemoBridge {
  return {
    install(openDocument) {
      window.__leanDemo = {
        currentUri: () => options.currentUri(),
        currentDoc: () => options.currentView()?.state.doc.toString() ?? null,
        replaceCurrentText(search: string, replacement: string) {
          const view = options.currentView();
          if (!view) {
            return false;
          }
          const source = view.state.doc.toString();
          const index = source.indexOf(search);
          if (index < 0) {
            return false;
          }
          view.dispatch({
            changes: {
              from: index,
              insert: replacement,
              to: index + search.length,
            },
          });
          return view.state.doc.toString() !== source;
        },
        setCursor(query: string) {
          const view = options.currentView();
          if (!view) {
            return false;
          }
          const index = view.state.doc.toString().indexOf(query);
          if (index < 0) {
            return false;
          }
          view.dispatch({
            selection: { anchor: index + Math.max(0, Math.floor(query.length / 2)) },
            scrollIntoView: true,
          });
          view.focus();
          return true;
        },
        undo() {
          return options.undo();
        },
        redo() {
          return options.redo();
        },
        openDocument,
      };
    },
  };
}
