import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import {
  createLeanLspClient,
  createLeanWorkspace,
  createWebSocketTransport,
  lean4,
  type LeanWorkspace,
} from "../../src/index.js";

import "./style.css";

interface DemoSession {
  rootUri: string;
  documentUri: string;
  documents: string[];
  initialDoc: string;
  websocketUrl: string;
}

const statusEl = document.querySelector<HTMLSpanElement>("#status");
const rootUriEl = document.querySelector<HTMLElement>("#root-uri");
const documentUriEl = document.querySelector<HTMLElement>("#document-uri");
const eventsEl = document.querySelector<HTMLDivElement>("#events");
const editorHost = document.querySelector<HTMLDivElement>("#editor");
const documentsEl = document.querySelector<HTMLDivElement>("#documents");

if (!statusEl || !rootUriEl || !documentUriEl || !eventsEl || !editorHost || !documentsEl) {
  throw new Error("Demo DOM is incomplete.");
}

const dom = {
  statusEl,
  rootUriEl,
  documentUriEl,
  eventsEl,
  editorHost,
  documentsEl,
};

declare global {
  interface Window {
    __leanDemo?: {
    currentUri(): string | null;
    currentDoc(): string | null;
    setCursor(query: string): boolean;
    undo(): boolean;
    redo(): boolean;
    openDocument(uri: string): Promise<void>;
  };
  }
}

function setStatus(text: string): void {
  dom.statusEl.textContent = text;
}

function logEvent(text: string): void {
  const item = document.createElement("div");
  item.className = "event";
  item.textContent = text;
  dom.eventsEl.prepend(item);
}

function demoTheme(): Extension {
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

let apiBase = import.meta.env.VITE_LEAN_DEMO_API ?? "http://127.0.0.1:7357";
let currentView: EditorView | null = null;
let currentUri: string | null = null;
let workspace: LeanWorkspace | null = null;
let client: ReturnType<typeof createLeanLspClient> | null = null;

async function fetchSession(): Promise<DemoSession> {
  const response = await fetch(`${apiBase}/session`);
  if (!response.ok) {
    throw new Error(`Session request failed with ${response.status}`);
  }
  return response.json() as Promise<DemoSession>;
}

async function fetchDocument(uri: string): Promise<string> {
  const response = await fetch(`${apiBase}/document?uri=${encodeURIComponent(uri)}`);
  if (!response.ok) {
    throw new Error(`Document request failed with ${response.status}`);
  }
  const payload = (await response.json()) as { text: string };
  return payload.text;
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), {
      once: true,
    });
  });
  return socket;
}

function setCurrentUri(uri: string): void {
  currentUri = uri;
  dom.documentUriEl.textContent = uri;
  for (const button of dom.documentsEl.querySelectorAll<HTMLButtonElement>("button")) {
    button.dataset.active = String(button.dataset.uri === uri);
  }
}

function installDemoApi(openDocument: (uri: string) => Promise<void>): void {
  window.__leanDemo = {
    currentUri: () => currentUri,
    currentDoc: () => currentView?.state.doc.toString() ?? null,
    setCursor(query: string) {
      if (!currentView) {
        return false;
      }
      const index = currentView.state.doc.toString().indexOf(query);
      if (index < 0) {
        return false;
      }
      currentView.dispatch({
        selection: { anchor: index + Math.max(0, Math.floor(query.length / 2)) },
        scrollIntoView: true,
      });
      currentView.focus();
      return true;
    },
    undo() {
      return currentView ? undo(currentView) : false;
    },
    redo() {
      return currentView ? redo(currentView) : false;
    },
    openDocument,
  };
}

async function mountDocument(uri: string, doc: string): Promise<EditorView> {
  client?.sync();
  currentView?.destroy();

  const view = new EditorView({
    parent: dom.editorHost,
    state: EditorState.create({
      doc,
      extensions: lean4({
        client,
        uri,
        utilities: {
          lineWrapping: true,
        },
        extraExtensions: [
          demoTheme(),
        ],
      }),
    }),
  });
  currentView = view;
  setCurrentUri(uri);
  return view;
}

function renderDocumentButtons(documents: string[], openDocument: (uri: string) => Promise<void>): void {
  dom.documentsEl.replaceChildren();
  for (const uri of documents) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.uri = uri;
    button.textContent = uri.split("/").at(-1) ?? uri;
    button.addEventListener("click", () => {
      void openDocument(uri);
    });
    dom.documentsEl.append(button);
  }
}

async function boot(): Promise<void> {
  setStatus("Loading session");
  const session = await fetchSession();
  dom.rootUriEl.textContent = session.rootUri;
  dom.documentUriEl.textContent = session.documentUri;

  setStatus("Connecting to Lean");
  const socket = await connectWebSocket(session.websocketUrl);
  client = createLeanLspClient({
    rootUri: session.rootUri,
    workspace: createLeanWorkspace({
      async loadDocument(uri) {
        return {
          doc: uri === session.documentUri ? session.initialDoc : await fetchDocument(uri),
        };
      },
      async displayDocument(uri, currentWorkspace) {
        const file = await currentWorkspace.requestFile(uri);
        const doc = file?.doc.toString() ?? await fetchDocument(uri);
        return mountDocument(uri, doc);
      },
    }),
  });
  client.connect(createWebSocketTransport(socket));
  await client.initializing;
  workspace = client.workspace as LeanWorkspace;

  const openDocument = async (uri: string): Promise<void> => {
    const file = await workspace?.requestFile(uri);
    const doc = file?.doc.toString() ?? await fetchDocument(uri);
    await mountDocument(uri, doc);
    logEvent(`Opened ${uri.split("/").at(-1) ?? uri}`);
  };

  installDemoApi(openDocument);
  renderDocumentButtons(session.documents, openDocument);
  await mountDocument(session.documentUri, session.initialDoc);

  socket.addEventListener("close", () => {
    setStatus("Disconnected");
    logEvent("Lean server connection closed.");
  });
  socket.addEventListener("error", () => {
    setStatus("Transport error");
    logEvent("WebSocket transport failed.");
  });
  window.addEventListener("beforeunload", () => {
    currentView?.destroy();
    client?.disconnect();
    socket.close();
  });

  setStatus("Ready");
  logEvent("Lean server initialized.");
}

void boot().catch((error) => {
  setStatus("Boot failed");
  logEvent(error instanceof Error ? error.message : String(error));
  throw error;
});
