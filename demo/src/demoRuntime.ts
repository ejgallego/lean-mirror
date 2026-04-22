import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";

import {
  createLeanLspClient,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  type LeanWorkspace,
} from "../../src/index.js";
import { createDemoBridge } from "./demoBridge.js";
import type { DemoSessionApi } from "./demoSession.js";
import type { DemoUi } from "./demoUi.js";
import { createEmbeddedEditorShell } from "./embeddedEditorShell.js";
import {
  embeddedBlockSourceMode,
  type AnyEmbeddedBlockEditorAdapter,
} from "./embeddedBlocks.js";

export interface DemoRuntimeOptions {
  editorTheme: Extension;
  embeddedAdapters: readonly AnyEmbeddedBlockEditorAdapter[];
  sessionApi: DemoSessionApi;
  ui: DemoUi;
}

export async function bootDemoRuntime(options: DemoRuntimeOptions): Promise<void> {
  let currentView: EditorView | null = null;
  let currentUri: string | null = null;
  let workspace: LeanWorkspace | null = null;
  let client: ReturnType<typeof createLeanLspClient> | null = null;
  let widgetsEnabled = true;

  function setCurrentUri(uri: string): void {
    currentUri = uri;
    options.ui.setCurrentDocument(uri);
    options.ui.setActiveDocument(uri);
  }

  const embeddedEditors = createEmbeddedEditorShell({
    currentUri() {
      return currentUri;
    },
    currentView() {
      return currentView;
    },
    log(message) {
      options.ui.logEvent(message);
    },
  });

  const embeddedBlockExtensions = embeddedEditors.extensionsFor(options.embeddedAdapters);
  const embeddedBlockSourceExtensions = embeddedBlockSourceMode(options.embeddedAdapters);
  const widgetsCompartment = new Compartment();
  const demoBridge = createDemoBridge({
    currentUri() {
      return currentUri;
    },
    currentView() {
      return currentView;
    },
    redo() {
      return currentView ? redo(currentView) : false;
    },
    undo() {
      return currentView ? undo(currentView) : false;
    },
  });

  async function mountDocument(uri: string, doc: string): Promise<EditorView> {
    client?.sync();
    embeddedEditors.close();
    currentView?.destroy();

    const view = new EditorView({
      parent: options.ui.editorHost,
      state: EditorState.create({
        doc,
        extensions: lean4({
          client,
          uri,
          utilities: {
            lineWrapping: true,
          },
          extraExtensions: [
            options.editorTheme,
            widgetsCompartment.of(
              widgetsEnabled ? embeddedBlockExtensions : embeddedBlockSourceExtensions,
            ),
          ],
        }),
      }),
    });
    currentView = view;
    setCurrentUri(uri);
    return view;
  }

  options.ui.setStatus("Loading session");
  options.ui.setWidgetsEnabled(widgetsEnabled);
  const session = await options.sessionApi.fetchSession();
  options.ui.setRootUri(session.rootUri);
  options.ui.setCurrentDocument(session.documentUri);

  options.ui.setStatus("Connecting to Lean");
  const socket = await options.sessionApi.connectWebSocket(session.websocketUrl);
  client = createLeanLspClient({
    rootUri: session.rootUri,
    workspace: createLeanWorkspace({
      async loadDocument(uri) {
        return {
          doc:
            uri === session.documentUri
              ? session.initialDoc
              : await options.sessionApi.fetchDocument(uri),
        };
      },
      async displayDocument(uri, currentWorkspace) {
        const file = await currentWorkspace.requestFile(uri);
        const doc = file?.doc.toString() ?? (await options.sessionApi.fetchDocument(uri));
        return mountDocument(uri, doc);
      },
    }),
  });
  client.connect(createWebSocketTransport(socket));
  await client.initializing;
  workspace = client.workspace as LeanWorkspace;

  const openDocument = async (uri: string): Promise<void> => {
    const file = await workspace?.requestFile(uri);
    const doc = file?.doc.toString() ?? (await options.sessionApi.fetchDocument(uri));
    await mountDocument(uri, doc);
    options.ui.logEvent(`Opened ${uri.split("/").at(-1) ?? uri}`);
  };

  options.ui.bindToggleWidgets(() => {
    widgetsEnabled = !widgetsEnabled;
    options.ui.setWidgetsEnabled(widgetsEnabled);
    options.ui.logEvent(`Embedded widgets ${widgetsEnabled ? "enabled" : "disabled"}.`);
    if (currentView) {
      embeddedEditors.close();
      currentView.dispatch({
        effects: widgetsCompartment.reconfigure(
          widgetsEnabled ? embeddedBlockExtensions : embeddedBlockSourceExtensions,
        ),
      });
    }
  });

  demoBridge.install(openDocument);
  options.ui.renderDocumentButtons(session.documents, openDocument);
  await mountDocument(session.documentUri, session.initialDoc);

  socket.addEventListener("close", () => {
    options.ui.setStatus("Disconnected");
    options.ui.logEvent("Lean server connection closed.");
  });
  socket.addEventListener("error", () => {
    options.ui.setStatus("Transport error");
    options.ui.logEvent("WebSocket transport failed.");
  });
  window.addEventListener("beforeunload", () => {
    embeddedEditors.close();
    currentView?.destroy();
    client?.disconnect();
    socket.close();
  });

  options.ui.setStatus("Ready");
  options.ui.logEvent("Lean server initialized.");
}
