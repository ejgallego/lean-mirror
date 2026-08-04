import type { LeanEditorSessionState } from "codemirror-lean4-lsp";
import type * as lsp from "vscode-languageserver-protocol";

import { mountLeanEditor, type MountedLeanEditor } from "./publicLeanEditor.js";
import "./style.css";

interface BackendSession {
  documentLanguageIds?: Record<string, string>;
  documents: string[];
  rootUri: string;
  websocketUrl: string;
}

const backendUrl = import.meta.env.VITE_LEAN_BACKEND_URL ?? "http://127.0.0.1:7470";

void start().catch((error: unknown) => {
  setStatus("status", "Failed");
  requiredElement<HTMLElement>("#fatal-error").textContent = errorMessage(error);
  console.error(error);
});

async function start(): Promise<void> {
  const backendSession = await fetchBackendSession();
  const documentUri = selectLeanDocument(backendSession.documents);
  const source = await fetchDocument(documentUri);
  const languageId = backendSession.documentLanguageIds?.[documentUri] ?? "lean4";
  const generation = requiredElement<HTMLElement>("#lean-generation");
  const restartButton = requiredElement<HTMLButtonElement>("#restart-lean");
  let editor: MountedLeanEditor | null = null;

  setStatus("document", documentUri);
  editor = await mountLeanEditor({
    document: { languageId, source, uri: documentUri },
    editorContainer: requiredElement<HTMLElement>("#minimal-editor"),
    infoviewContainer: requiredElement<HTMLElement>("#lean-infoview"),
    loadDocument: fetchDocument,
    onDiagnostics(params) {
      if (params.uri === documentUri) {
        setStatus("diagnostics", diagnosticSummary(params.diagnostics));
      }
    },
    onError(error) {
      setStatus("status", `Failed: ${errorMessage(error)}`);
    },
    onReconnectStart() {
      setStatus("status", "Reconnecting");
    },
    onSessionState(state) {
      renderSessionState(state, generation, restartButton);
    },
    rootUri: backendSession.rootUri,
    websocketUrl: backendSession.websocketUrl,
  });

  restartButton.addEventListener("click", () => {
    void editor?.reconnect().catch(() => undefined);
  });
  window.addEventListener("beforeunload", () => editor?.dispose(), { once: true });
}

function renderSessionState(
  state: LeanEditorSessionState,
  generation: HTMLElement,
  restartButton: HTMLButtonElement,
): void {
  generation.textContent = `Generation ${state.generation}`;
  generation.dataset.phase = state.phase;
  const reconnecting = state.generation > 1 && state.phase === "initializing";
  restartButton.disabled = reconnecting;
  restartButton.textContent = reconnecting ? "Reconnecting…" : "Reconnect Lean";
  switch (state.phase) {
    case "idle":
      setStatus("status", "Disconnected");
      break;
    case "initializing":
      setStatus("status", "Connecting");
      break;
    case "ready":
      setStatus("status", "Ready");
      break;
    case "failed":
      setStatus("status", `Failed: ${errorMessage(state.error)}`);
      break;
    case "disposed":
      setStatus("status", "Disposed");
      break;
  }
}

async function fetchBackendSession(): Promise<BackendSession> {
  const response = await fetch(`${backendUrl}/session`);
  if (!response.ok) {
    throw new Error(`Session request failed with ${response.status}.`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new Error("Session response must be an object.");
  }
  const documents = stringArray(value.documents);
  if (!documents || typeof value.rootUri !== "string" || typeof value.websocketUrl !== "string") {
    throw new Error("Session response is missing its Lean workspace fields.");
  }
  const documentLanguageIds = stringRecord(value.documentLanguageIds);
  return {
    ...(documentLanguageIds ? { documentLanguageIds } : {}),
    documents,
    rootUri: value.rootUri,
    websocketUrl: value.websocketUrl,
  };
}

async function fetchDocument(uri: string): Promise<string> {
  const response = await fetch(`${backendUrl}/document?uri=${encodeURIComponent(uri)}`);
  if (!response.ok) {
    throw new Error(`Document request failed with ${response.status}.`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error("Document response must contain text.");
  }
  return value.text;
}

function diagnosticSummary(diagnostics: readonly lsp.Diagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 2).length;
  return `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
}

function selectLeanDocument(documents: readonly string[]): string {
  const selected = documents.find((uri) => uri.endsWith("/Helper.lean")) ??
    documents.find((uri) => uri.endsWith(".lean"));
  if (!selected) {
    throw new Error("The backend session did not provide a Lean document.");
  }
  return selected;
}

function setStatus(kind: string, value: string): void {
  requiredElement<HTMLElement>(
    `[data-platform-status-part="value"][data-platform-status-kind="${kind}"]`,
  ).textContent = value;
}

function requiredElement<ElementType extends HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Missing required element ${selector}.`);
  }
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    return null;
  }
  return value as Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown Lean session failure");
}
