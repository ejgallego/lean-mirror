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
import "./style.css";

const $ = (selector) => document.querySelector(selector);
const status = $("#status"),
  outline = $("#outline");
const policy = $("#policy"),
  names = $("#names");
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
  const selected = [],
    others = [];
  for (const command of response.commands) {
    // Zero-width end-of-input is not a reader-facing command.
    if (command.range.start === command.range.stop) continue;
    const regions = (suffix) =>
      command.regions.filter((r) => r.kind.endsWith("." + suffix));
    const ids = regions("declId");
    const card = element("article", undefined, "card");
    const heading = element("div", undefined, "card-top");
    heading.append(
      element(
        "h3",
        ids.map((r) => r.text).join(" · ") || command.kind.split(".").at(-1),
      ),
      element(
        "span",
        regions("theorem").length
          ? "theorem"
          : ids.length
            ? "definition"
            : "context",
        "kind",
      ),
    );
    card.append(heading);
    for (const doc of [...regions("docComment"), ...regions("moduleDoc")])
      card.append(element("p", doc.text.slice(3, -2).trim(), "doc"));
    const signatures = [...regions("declSig"), ...regions("optDeclSig")];
    if (ids.length === 1 && signatures.length === 1)
      card.append(element("div", signatures[0].text, "statement"));
    const actions = element("div", undefined, "actions");
    const details = element("details");
    details.append(
      element("summary", "Expand source / proof"),
      element("pre", source.slice(command.range.start, command.range.stop)),
    );
    const reveal = element("button", "Locate in source ↗");
    reveal.type = "button";
    reveal.addEventListener("click", () => {
      editor.dispatch({
        selection: { anchor: command.range.start, head: command.range.stop },
        effects: EditorView.scrollIntoView(command.range.start, {
          y: "center",
        }),
      });
      editor.focus();
    });
    actions.append(details, reveal);
    card.append(actions);
    (command.selected ? selected : others).push(card);
  }
  outline.replaceChildren(...selected);
  if (!selected.length)
    outline.append(
      element("p", "No matching commands in this snapshot.", "empty"),
    );
  if (others.length) {
    const hidden = element("details", undefined, "other");
    hidden.append(
      element("summary", `Explore ${others.length} other commands`),
      ...others,
    );
    outline.append(hidden);
  }
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
  const selectedPolicy = policy.value,
    selectedNames = names.value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  try {
    for (let attempt = 0; attempt < 20 && ticket === generation; attempt++) {
      status.textContent = `Reading revision ${capturedVersion}…`;
      const params = {
        textDocument: { uri: session.uri, version: capturedVersion },
        source,
        waitMs: 1000,
        policy: selectedPolicy,
        names: selectedNames,
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
          ? `Revision ${capturedVersion} · ${count} selected commands`
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
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...lean4({ session: leanSession, uri: session.uri }),
        EditorView.contentAttributes.of({ "aria-label": "Lean source" }),
        EditorView.updateListener.of((update) => {
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
  socket = new WebSocket(`ws://${location.host}/lsp`);
  socket.addEventListener("close", disconnected);
  await waitForWebSocketOpen(socket);
  await leanSession.connect(createWebSocketTransport(socket), {
    disposeTransport: () => socket.close(),
  }).initialized;
  ready = true;
  schedule();
}
policy.addEventListener("change", () => {
  $("#names-label").hidden = policy.value !== "names";
  schedule();
});
names.addEventListener("input", schedule);
$("#refresh").addEventListener("click", schedule);
window.addEventListener("pagehide", () => {
  editor?.destroy();
  leanSession?.dispose();
  socket?.close();
});
start().catch((error) => {
  status.textContent = error.message;
});
