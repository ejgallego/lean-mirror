import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  createLeanEditorSession,
  createLeanWorkspace,
  createWebSocketTransport,
  waitForWebSocketOpen,
  lean4,
} from "../../../src/index.ts";
import {
  enrichment,
  displayField,
  displayEffect,
  snapshotRegions,
} from "./enrichment.js";
import "./style.css";

const $ = (selector) => document.querySelector(selector);
const status = $("#status"),
  outline = $("#outline");
const presentation = $("#presentation"),
  focus = $("#focus-contributions");
let socket,
  editor,
  session,
  ready = false,
  editSequence = 0,
  generation = 0,
  leanSession;
let timer, currentRequest;
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function cancelCurrent() {
  if (currentRequest)
    currentRequest.client.cancelRequest(currentRequest.params);
  currentRequest = undefined;
}
function showDiagnostics(client, params) {
  const file = client.workspace.getFile(session.uri);
  if (
    params.uri !== session.uri ||
    !file ||
    params.version !== file.version ||
    !editor ||
    !file.doc.eq(editor.state.doc)
  )
    return false;
  const panel = $("#diagnostics");
  panel.replaceChildren(
    ...params.diagnostics.map((d) =>
      element(
        "p",
        `Line ${d.range.start.line + 1}: ${d.message}`,
        d.severity === 1 ? "error" : "message",
      ),
    ),
  );
  if (!params.diagnostics.length)
    panel.append(
      element("p", `No diagnostics reported for revision ${params.version}.`),
    );
  panel.dataset.version = String(params.version);
  const pos = (p) => {
    const line = editor.state.doc.line(
      Math.min(p.line + 1, editor.state.doc.lines),
    );
    return line.from + Math.min(p.character, line.length);
  };
  editor.dispatch({
    effects: displayEffect.of({
      type: "diagnostics",
      items: params.diagnostics.map((d) => ({
        from: pos(d.range.start),
        to: pos(d.range.end),
        message: d.message,
      })),
    }),
  });
  for (const [index, node] of [...panel.children].entries()) {
    const diagnostic = params.diagnostics[index];
    if (!diagnostic) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Reveal diagnostic";
    b.addEventListener("click", () => {
      editor.dispatch({
        selection: { anchor: pos(diagnostic.range.start) },
        scrollIntoView: true,
      });
      editor.focus();
    });
    node.append(b);
  }
  return false; // Also let the library update editor diagnostics.
}
function invalidate(message) {
  generation++;
  delete outline.dataset.version;
  delete outline.dataset.snapshotStatus;
  clearTimeout(timer);
  cancelCurrent();
  outline.replaceChildren(element("p", message, "empty"));
}
function schedule() {
  invalidate("Updating the document view…");
  status.textContent = ready ? "Updating Lean…" : "Waiting for Lean…";
  if (ready) timer = setTimeout(() => refresh(generation), 200);
}
function render(response, source) {
  editor.dispatch({
    effects: displayEffect.of({
      type: "snapshot",
      regions: snapshotRegions(response, source, session.source),
      complete: response.snapshotStatus === "complete",
    }),
  });
  outline.textContent = `${response.commands.length} worker commands · ${response.snapshotStatus}`;
  outline.dataset.version = String(response.version);
  outline.dataset.snapshotStatus = response.snapshotStatus;
}
async function refresh(ticket) {
  if (!ready || ticket !== generation) return;
  const client = leanSession.client;
  client.sync();
  const file = client.workspace.getFile(session.uri);
  if (!file) return;
  const source = editor.state.doc.toString(),
    capturedVersion = file.version,
    capturedEditSequence = editSequence;
  $("#revision").textContent = `Revision ${capturedVersion}`;

  try {
    for (let attempt = 0; attempt < 20 && ticket === generation; attempt++) {
      status.textContent = `Reading revision ${capturedVersion}…`;
      const params = {
        textDocument: { uri: session.uri, version: capturedVersion },
        source,
        waitMs: 1000,
        policy: "all",
        names: [],
      };
      currentRequest = { client, params };
      const response = await client.request(
        "$/leanMirror/displayProbe",
        params,
      );
      if (
        ticket !== generation ||
        !ready ||
        capturedEditSequence !== editSequence ||
        client !== leanSession.client
      )
        return;
      currentRequest = undefined;
      if (response.version !== capturedVersion)
        throw new Error("Snapshot revision mismatch");
      render(response, source);
      const count = response.commands.filter(
        (c) => c.selected && c.range.start !== c.range.stop,
      ).length;
      status.textContent =
        response.snapshotStatus === "complete"
          ? `Revision ${capturedVersion} · ${count} worker commands`
          : `Revision ${capturedVersion} · partial view`;
      if (response.snapshotStatus === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (ticket === generation)
      status.textContent = "Analysis pending · refresh to continue";
  } catch (error) {
    if (ticket !== generation) return;
    outline.replaceChildren(
      element(
        "p",
        "The source remains available. Refresh to try again.",
        "empty",
      ),
    );
    status.textContent = error.message;
  }
}
function disconnected() {
  ready = false;
  editor?.dispatch({ effects: displayEffect.of({ type: "clear" }) });
  delete outline.dataset.version;
  delete outline.dataset.snapshotStatus;
  generation++;
  clearTimeout(timer);
  currentRequest = undefined;
  outline.replaceChildren(
    element(
      "p",
      "Connection closed. Reload this page to start a new Lean session.",
      "empty",
    ),
  );
  status.textContent = "Disconnected";
  $("#diagnostics").replaceChildren(
    element("p", "Lean disconnected; diagnostics unavailable."),
  );
  delete $("#diagnostics").dataset.version;
}
async function start() {
  const response = await fetch("/session");
  if (!response.ok) throw new Error("Cannot load demo session");
  session = await response.json();
  leanSession = createLeanEditorSession({
    client: {
      rootUri: session.rootUri,
      workspace: createLeanWorkspace({
        displayDocument: async (uri) => (uri === session.uri ? editor : null),
      }),
      notificationHandlers: {
        "textDocument/publishDiagnostics": showDiagnostics,
      },
    },
  });
  editor = new EditorView({
    parent: $("#editor"),
    state: EditorState.create({
      doc: session.source,
      extensions: [
        lineNumbers(),
        EditorView.lineWrapping,
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...lean4({ session: leanSession, uri: session.uri }),
        enrichment,
        EditorView.contentAttributes.of({ "aria-label": "Lean source" }),
        EditorView.updateListener.of((update) => {
          const model = update.state.field(displayField);
          $("#interaction-status").textContent = model.notice;
          $("#contribution-count").textContent =
            `${model.marks.size} contributions${model.focus && !model.marks.size ? " · none selected; turn focus off to show all" : ""}`;
          if (!update.docChanged) return;
          editSequence++;
          $("#revision").textContent = "Edited · synchronizing";
          $("#diagnostics").replaceChildren(
            element("p", "Waiting for diagnostics for this edit…"),
          );
          delete $("#diagnostics").dataset.version;
          schedule();
        }),
      ],
    }),
  });
  session.source = editor.state.doc.toString(); // Bind supplied data to the exact LF editor text.
  socket = new WebSocket(`ws://${location.host}/lsp`);
  socket.addEventListener("close", disconnected);
  await waitForWebSocketOpen(socket);
  await leanSession.connect(createWebSocketTransport(socket), {
    disposeTransport: () => socket.close(),
  }).initialized;
  ready = true;
  schedule();
}
presentation.addEventListener("change", () =>
  editor?.dispatch({
    effects: [
      editor.scrollSnapshot(),
      displayEffect.of({ type: "mode", mode: presentation.value }),
    ],
  }),
);
focus.addEventListener("change", () =>
  editor?.dispatch({
    effects: [
      editor.scrollSnapshot(),
      displayEffect.of({ type: "focus", value: focus.checked }),
    ],
  }),
);
export const getEditor = () => editor;
$("#refresh").addEventListener("click", schedule);
window.addEventListener("pagehide", () => {
  ready = false;
  generation++;
  clearTimeout(timer);
  cancelCurrent();
  socket?.removeEventListener("close", disconnected);
  editor?.destroy();
  editor = undefined;
  leanSession?.dispose();
  socket?.close();
});
start().catch((error) => {
  status.textContent = error.message;
});
