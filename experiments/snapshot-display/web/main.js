import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { leanFallbackLanguageSupport } from "../../../src/language.ts";
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
  version = 1,
  generation = 0,
  nextId = 0;
let timer, currentRequest;
const pending = new Map();
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function send(message) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
}
function request(method, params) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      if (socket.readyState === WebSocket.OPEN)
        send({ method: "$/cancelRequest", params: { id } });
      reject(new Error("Lean did not respond. Try Refresh view."));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params });
  });
  return { id, promise };
}
function cancelCurrent() {
  if (!currentRequest) return;
  const id = currentRequest.id;
  const p = pending.get(id);
  if (p) {
    send({ method: "$/cancelRequest", params: { id } });
    pending.delete(id);
    clearTimeout(p.timeout);
    p.reject(new Error("Superseded"));
  }
  currentRequest = undefined;
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
  status.textContent = ready
    ? `Reading revision ${version}…`
    : "Waiting for Lean…";
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
  const source = editor.state.doc.toString(),
    capturedVersion = version;
  const selectedPolicy = policy.value,
    selectedNames = names.value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  try {
    for (let attempt = 0; attempt < 20 && ticket === generation; attempt++) {
      status.textContent = `Reading revision ${capturedVersion}…`;
      currentRequest = request("$/leanMirror/displayProbe", {
        textDocument: { uri: session.uri, version: capturedVersion },
        source,
        waitMs: 1000,
        policy: selectedPolicy,
        names: selectedNames,
      });
      const response = await currentRequest.promise;
      if (ticket !== generation || !ready || capturedVersion !== version)
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
  for (const p of pending.values()) {
    clearTimeout(p.timeout);
    p.reject(new Error("Disconnected"));
  }
  pending.clear();
  currentRequest = undefined;
  outline.replaceChildren(
    element(
      "p",
      "Connection closed. Reload this page to start a new Lean session.",
      "empty",
    ),
  );
  status.textContent = "Disconnected";
}
async function start() {
  const response = await fetch("/session");
  if (!response.ok) throw new Error("Cannot load demo session");
  session = await response.json();
  editor = new EditorView({
    parent: $("#editor"),
    state: EditorState.create({
      doc: session.source,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        leanFallbackLanguageSupport(),
        EditorView.contentAttributes.of({ "aria-label": "Lean source" }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          version++;
          $("#revision").textContent = `Revision ${version}`;
          if (ready)
            send({
              method: "textDocument/didChange",
              params: {
                textDocument: { uri: session.uri, version },
                contentChanges: [{ text: editor.state.doc.toString() }],
              },
            });
          schedule();
        }),
      ],
    }),
  });
  socket = new WebSocket(`ws://${location.host}/lsp`);
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method) {
      if (msg.id !== undefined)
        send({
          id: msg.id,
          error: { code: -32601, message: "Unsupported client method" },
        });
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timeout);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  socket.addEventListener("close", disconnected);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Cannot connect to Lean")),
      { once: true },
    );
  });
  await request("initialize", {
    processId: null,
    rootUri: session.rootUri,
    capabilities: {},
    initializationOptions: { hasWidgets: false },
  }).promise;
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: session.uri,
        version,
        languageId: "lean4",
        text: editor.state.doc.toString(),
      },
    },
  });
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
  socket?.close();
  editor?.destroy();
});
start().catch((error) => {
  status.textContent = error.message;
});
