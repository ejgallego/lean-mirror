import { mountLeanWorkspace, type MountedLeanWorkspace, type WorkspaceDocument, type WorkspaceDocumentState } from "./publicLeanWorkspace.js";
import "./workspace.css";

const backend = import.meta.env.VITE_LEAN_BACKEND_URL ?? "http://127.0.0.1:7458";
const element = <T extends HTMLElement>(selector: string): T => {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error("Missing workspace element " + selector);
  return value;
};
const states = new Map<string, WorkspaceDocumentState>();
let workspace: MountedLeanWorkspace | null = null;
const status = element("#connection-status");
const feedback = element("#save-status");
const save = element<HTMLButtonElement>("#save-all");
const restart = element<HTMLButtonElement>("#reconnect");
const files = element("#workspace-files");

async function snapshot(uri: string): Promise<WorkspaceDocument> {
  const response = await fetch(backend + "/lean-document?uri=" + encodeURIComponent(uri));
  if (!response.ok) throw new Error(await response.text());
  return readSnapshot(await response.json());
}
function readSnapshot(value: unknown): WorkspaceDocument {
  if (!value || typeof value !== "object" || !("uri" in value) || !("text" in value) || !("revision" in value) ||
      typeof value.uri !== "string" || typeof value.text !== "string" || typeof value.revision !== "string") {
    throw new Error("Invalid document snapshot.");
  }
  return { uri: value.uri, text: value.text, revision: value.revision };
}
async function start(): Promise<void> {
  const response = await fetch(backend + "/session");
  if (!response.ok) throw new Error("Workspace backend failed to start.");
  const session: unknown = await response.json();
  if (!session || typeof session !== "object" || !("documents" in session) || !Array.isArray(session.documents) ||
      !("rootUri" in session) || typeof session.rootUri !== "string" ||
      !("websocketUrl" in session) || typeof session.websocketUrl !== "string") throw new Error("Invalid workspace session.");
  const uris = session.documents.filter((uri): uri is string =>
    typeof uri === "string" && (uri.endsWith("/Main.lean") || uri.endsWith("/Helper.lean")));
  uris.sort((a, b) => Number(b.endsWith("/Main.lean")) - Number(a.endsWith("/Main.lean")));
  if (uris.length !== 2) throw new Error("This host requires the local Main.lean and Helper.lean workspace.");
  const documents = await Promise.all(uris.map(snapshot));
  const buttons = new Map<string, HTMLButtonElement>();
  for (const document of documents) {
    const button = window.document.createElement("button");
    button.type = "button";
    button.dataset.uri = document.uri;
    button.textContent = document.uri.split("/").at(-1) ?? document.uri;
    button.addEventListener("click", () => workspace?.showDocument(document.uri).focus());
    buttons.set(document.uri, button);
    files.append(button);
  }
  workspace = await mountLeanWorkspace({
    documents, rootUri: session.rootUri, websocketUrl: session.websocketUrl,
    editorContainer: element("#workspace-editor"),
    infoviewContainer: element("#workspace-infoview"),
    async saveDocument(document) {
      const result = await fetch(backend + "/lean-document", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document),
      });
      if (!result.ok) throw new Error(await result.text());
      return readSnapshot(await result.json());
    },
    onActiveDocument(uri) {
      element("#active-file").textContent = uri.split("/").at(-1) ?? uri;
      for (const [candidate, button] of buttons) button.setAttribute("aria-pressed", String(candidate === uri));
    },
    onDocumentState(state) {
      states.set(state.uri, state);
      const button = buttons.get(state.uri);
      if (button) button.textContent = (state.uri.split("/").at(-1) ?? state.uri) + (state.dirty ? " •" : "");
      save.disabled = [...states.values()].some((entry) => entry.saving) || ![...states.values()].some((entry) => entry.dirty);
      feedback.textContent = [...states.values()].find((entry) => entry.error)?.error ??
        ([...states.values()].some((entry) => entry.saving) ? "Saving…" :
          [...states.values()].some((entry) => entry.dirty) ? "Unsaved changes" : "All changes saved");
    },
    onSessionState(state) {
      status.dataset.generation = String(state.generation);
      status.dataset.phase = state.phase;
      status.textContent = state.phase === "ready" ? "Ready" : state.phase === "initializing" ? "Connecting…" : "Disconnected";
      restart.disabled = state.phase === "initializing";
    },
    onReconnectStart() { status.textContent = "Reconnecting…"; },
    onError(error) { status.textContent = "Offline — edits are kept"; feedback.textContent = String(error); },
  });
  save.addEventListener("click", () => { void workspace?.saveAll().catch(() => undefined); });
  restart.addEventListener("click", () => { void workspace?.reconnect().catch(() => undefined); });
  window.addEventListener("beforeunload", () => workspace?.dispose(), { once: true });
}
void start().catch((error: unknown) => {
  status.textContent = "Workspace unavailable";
  feedback.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
