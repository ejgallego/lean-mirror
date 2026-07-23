import type { EditorView } from "@codemirror/view";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  lean4,
  type LeanWorkspace,
} from "codemirror-lean4-lsp";
import {
  createLeanInfoviewHost,
  leanInfoviewClientNotifications,
  type LeanInfoviewHost,
} from "codemirror-lean4-lsp/infoview";

declare const container: HTMLElement;
declare const currentUri: string | null;
declare const currentView: EditorView | null;

let infoview: LeanInfoviewHost | null = null;
const session = createLeanEditorSession({
  client: {
    extensions: [
      leanInfoviewClientNotifications(() => infoview),
    ],
    workspace: createLeanWorkspace(),
  },
});

infoview = createLeanInfoviewHost({
  client: () => session.client,
  container,
  currentLanguageId: () => "lean4",
  currentUri: () => currentUri,
  currentView: () => currentView,
  requestRestart() {},
  workspace: () => (session.client?.workspace as LeanWorkspace | undefined) ?? null,
});

const editorExtensions = lean4({
  session,
  uri: "file:///Main.lean",
});
void editorExtensions;
void infoview.editorExtension();
