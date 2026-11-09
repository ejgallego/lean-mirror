// Experiment-local projection. Lean supplies boundaries; no frontend Lean parser.
import {
  EditorState,
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  Prec,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export const displayEffect = StateEffect.define();
const supplied = {
  identity_eq: {
    header: "theorem identity_eq : identity x = x",
    math: "identity(x) = x",
    context: "α : Type; x : α",
  },
  helper: {
    header: "private theorem helper (n : Nat) : n = n",
    math: "n = n",
    context: "n ∈ ℕ",
  },
  local_eq: {
    header: "theorem local_eq (n : 𝓝) : n = n",
    math: "n = n",
    context: "n ∈ ℕ",
  },
};
export function snapshotRegions(response, source, fixture) {
  const candidates = response.commands.flatMap((c) => {
    const names = c.regions
      .filter((r) => r.kind.endsWith(".declId"))
      .map((r) => r.text);
    if (!names.length) return [];
    const key = `${c.namespaceName}:${names.join(",")}`;
    const sample =
      source === fixture && names.length === 1 ? supplied[names[0]] : null;
    const start = sample ? source.indexOf(sample.header, c.range.start) : -1;
    const presentation =
      sample &&
      start >= c.range.start &&
      start + sample.header.length <= c.range.stop
        ? {
            ...sample,
            statement: { from: start, to: start + sample.header.length },
          }
        : null;
    return [
      {
        key,
        name: names.join(" · "),
        from: c.range.start,
        to: c.range.stop,
        presentation,
        docs: c.regions
          .filter((r) => r.kind.endsWith(".docComment"))
          .map((r) => r.text.slice(3, -2).trim())
          .join("\n"),
        proof: c.regions.find(
          (r) =>
            r.kind.endsWith(".declValSimple") ||
            r.kind.endsWith(".declValEqns"),
        )?.range.start,
      },
    ];
  });
  // Ambiguous ownership is a source-only case, never an inferred declaration ID.
  return candidates.filter(
    (r) => candidates.filter((s) => s.key === r.key).length === 1,
  );
}
function selected(selection, r) {
  return selection.ranges.some((s) =>
    s.empty
      ? s.head >= r.from && s.head <= r.to
      : s.from < r.to && s.to > r.from,
  );
}
function hiddenRegions(model, selection) {
  return model.regions.filter(
    (r) =>
      !model.open.has(r.key) &&
      (model.owner !== null || !selected(selection, r)) &&
      ((model.focus && !model.marks.has(r.key)) ||
        (model.mode === "rendered" && r.presentation)),
  );
}
function hits(from, to, r) {
  return from === to
    ? from > r.from && from < r.to
    : from < r.to && to > r.from;
}
function message(view, text) {
  view.dispatch({ effects: displayEffect.of({ type: "message", text }) });
}
function header(view, key) {
  return [...view.dom.querySelectorAll(".enrich-header")].find(
    (n) => n.dataset.key === key,
  );
}
function edit(
  view,
  key,
  { selectStatement = false, proof = false, blocked = false } = {},
) {
  const m = view.state.field(displayField),
    r = m.regions.find((r) => r.key === key);
  if (!r) return;
  const saved = m.bookmarks.get(key);
  const selection =
    selectStatement && r.presentation
      ? EditorSelection.single(
          r.presentation.statement.from,
          r.presentation.statement.to,
        )
      : proof
        ? EditorSelection.single(r.proof ?? r.from)
        : (saved ?? EditorSelection.single(r.from));
  view.dispatch({
    effects: displayEffect.of({ type: "open", keys: [key], blocked }),
    selection,
    scrollIntoView: true,
  });
  view.focus();
}
function returnToDisplay(view, key) {
  const m = view.state.field(displayField),
    r = m.regions.find((r) => r.key === key);
  if (!r?.presentation || m.mode !== "rendered") {
    message(
      view,
      m.mode !== "rendered"
        ? "Choose Rendered to return this region to display."
        : "Presentation unavailable for this revision; source stays open.",
    );
    return;
  }
  if (view.state.selection.ranges.some((s) => s.from < r.from || s.to > r.to)) {
    message(
      view,
      "Narrow all source selections to this declaration before returning to display.",
    );
    return;
  }
  const selection = view.state.selection;
  // This button survives both the source and rendered representations.
  header(view, key)
    ?.querySelector("[data-action=edit]")
    ?.focus({ preventScroll: true });
  view.dispatch({
    selection: EditorSelection.single(0),
    effects: displayEffect.of({ type: "return", key, selection }),
  });
}
function selectRegion(view, key, target) {
  target.focus({ preventScroll: true });
  view.dispatch({
    selection: EditorSelection.single(0),
    effects: displayEffect.of({ type: "owner", key }),
  });
}
async function copy(view, key, math = false) {
  const m = view.state.field(displayField),
    r = m.regions.find((r) => r.key === key);
  if (!r?.presentation) return;
  const p = r.presentation;
  try {
    await navigator.clipboard.writeText(
      math
        ? `${p.context}; ${p.math}`
        : view.state.sliceDoc(p.statement.from, p.statement.to),
    );
    message(
      view,
      math
        ? "Copied supplied mathematics."
        : "Copied Lean statement (without proof).",
    );
  } catch {
    message(view, "Clipboard unavailable. Reveal source to copy it.");
  }
}
class RegionWidget extends WidgetType {
  constructor(region, companion, signature) {
    super();
    this.region = region;
    this.companion = companion;
    this.signature = signature;
  }
  eq(other) {
    return (
      this.region.key === other.region.key &&
      this.companion === other.companion &&
      this.signature === other.signature
    );
  }
  toDOM(view) {
    const root = document.createElement("section");
    root.className = this.companion ? "enrich-companion" : "enrich-header";
    root.dataset.key = this.region.key;
    root.contentEditable = "false";
    const controls = document.createElement("div");
    controls.className = "enrich-controls";
    root.append(controls);
    const title = document.createElement("strong");
    title.className = "enrich-title";
    controls.append(title);
    const buttons = [
      ["mark", "Mark contribution"],
      ["edit", "Edit source"],
      ["return", "Return to display"],
      ["proof", "Show proof with source"],
      ["copy", "Copy Lean statement"],
      ["math", "Copy rendered mathematics"],
    ];
    for (const [action, label] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.action = action;
      b.textContent = label;
      controls.append(b);
      b.addEventListener("click", () => {
        const key = root.dataset.key;
        if (action === "mark")
          view.dispatch({ effects: displayEffect.of({ type: "mark", key }) });
        if (action === "edit") edit(view, key);
        if (action === "proof") edit(view, key, { proof: true });
        if (action === "return") returnToDisplay(view, key);
        if (action === "copy") void copy(view, key);
        if (action === "math") void copy(view, key, true);
      });
    }
    const reason = document.createElement("div");
    reason.className = "enrich-reason";
    root.append(reason);
    const preview = document.createElement("div");
    preview.className = "enrich-preview";
    root.append(preview);
    const doc = document.createElement("p");
    doc.className = "enrich-doc";
    preview.append(doc);
    const select = document.createElement("button");
    select.type = "button";
    select.className = "enrich-equation";
    preview.append(select);
    select.addEventListener("click", () =>
      selectRegion(view, root.dataset.key, select),
    );
    const context = document.createElement("p");
    context.className = "enrich-context";
    preview.append(context);
    const provenance = document.createElement("p");
    provenance.className = "enrich-provenance";
    preview.append(provenance);
    root.addEventListener("keydown", (e) => {
      const m = view.state.field(displayField);
      if (m.owner !== root.dataset.key) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void copy(view, m.owner);
      } else if (
        e.key === "Delete" ||
        e.key === "Backspace" ||
        ((e.ctrlKey || e.metaKey) && ["x", "v"].includes(e.key.toLowerCase()))
      ) {
        e.preventDefault();
        if (!e.repeat)
          edit(view, m.owner, {
            selectStatement: true,
            blocked: ["Delete", "Backspace"].includes(e.key),
          });
      }
    });
    root.addEventListener("copy", (e) => {
      const m = view.state.field(displayField),
        r = m.regions.find((r) => r.key === m.owner);
      if (
        m.owner !== root.dataset.key ||
        !root.contains(document.activeElement) ||
        !r?.presentation
      )
        return;
      e.preventDefault();
      e.clipboardData.setData(
        "text/plain",
        view.state.sliceDoc(
          r.presentation.statement.from,
          r.presentation.statement.to,
        ),
      );
    });
    for (const type of ["cut", "paste"])
      root.addEventListener(type, (e) => {
        const m = view.state.field(displayField);
        if (
          m.owner !== root.dataset.key ||
          !root.contains(document.activeElement)
        )
          return;
        e.preventDefault();
        edit(view, m.owner, { selectStatement: true });
      });
    this.updateDOM(root, view);
    return root;
  }
  updateDOM(root, view) {
    if (root.dataset.key !== this.region.key) return false;
    const m = view.state.field(displayField),
      r = this.region;
    const hidden = hiddenRegions(m, view.state.selection).some(
      (x) => x.key === r.key,
    );
    const folded = hidden && m.focus && !m.marks.has(r.key);
    const isSelected = m.owner === r.key;
    const errors = m.diagnostics.filter((d) => hits(d.from, d.to, r));
    root.dataset.marked = String(m.marks.has(r.key));
    root.dataset.selected = String(isSelected);
    root.dataset.hiddenSource = String(hidden);
    root.querySelector(".enrich-title").textContent = r.name;
    const button = (a) => root.querySelector(`[data-action=${a}]`);
    button("mark").textContent = m.marks.has(r.key)
      ? "Contribution ✓"
      : "Mark contribution";
    button("mark").setAttribute("aria-pressed", String(m.marks.has(r.key)));
    button("edit").textContent = folded
      ? "Show supporting declaration"
      : "Edit source";
    button("edit").setAttribute("aria-expanded", String(!hidden));
    button("return").hidden =
      hidden || m.mode !== "rendered" || !r.presentation;
    button("proof").hidden = !hidden || folded || r.proof === undefined;
    button("copy").hidden = button("math").hidden =
      !r.presentation || !isSelected;
    root.querySelector(".enrich-controls").hidden = this.companion;
    let presentationLabel = "Source with companion";
    if (folded) presentationLabel = "Supporting declaration collapsed";
    else if (hidden) presentationLabel = "Rendered";
    else if (m.mode === "source") presentationLabel = "Source";
    else if (m.open.has(r.key) || selected(view.state.selection, r))
      presentationLabel = "Source open";
    else if (!r.presentation)
      presentationLabel = "Presentation unavailable for this revision";
    const feedback = m.checking
      ? "checking"
      : errors.length
        ? `${errors.length} diagnostic(s)`
        : "no diagnostics reported";
    root.querySelector(".enrich-reason").textContent = this.companion
      ? ""
      : `${presentationLabel} · ${feedback}${isSelected ? " · Lean statement selected" : ""}`;
    const preview = root.querySelector(".enrich-preview");
    preview.hidden =
      folded ||
      !(this.companion || (hidden && m.mode === "rendered")) ||
      !r.presentation;
    root.querySelector(".enrich-doc").textContent = r.docs;
    const equation = root.querySelector(".enrich-equation");
    equation.textContent = r.presentation?.math ?? "";
    equation.setAttribute(
      "aria-label",
      `Select whole Lean statement: ${r.name}. ${r.presentation?.context ?? ""}; ${r.presentation?.math ?? ""}`,
    );
    equation.setAttribute("aria-pressed", String(isSelected));
    root.querySelector(".enrich-context").textContent =
      r.presentation?.context ?? "";
    root.querySelector(".enrich-provenance").textContent =
      "Supplied fixture presentation · proof validity not inferred";
    return true;
  }
  ignoreEvent() {
    return true;
  }
}
function decorations(m, state) {
  const result = [],
    hidden = hiddenRegions(m, state.selection);
  for (const r of m.regions) {
    const hide = hidden.some((x) => x.key === r.key);
    const signature = JSON.stringify([
      r,
      m.mode,
      m.focus,
      m.marks.has(r.key),
      m.open.has(r.key),
      m.owner === r.key,
      hide,
      m.diagnostics,
      m.checking,
    ]);
    result.push(
      Decoration.widget({
        widget: new RegionWidget(r, false, signature),
        block: true,
        side: -1,
      }).range(r.from),
    );
    if (hide)
      result.push(Decoration.replace({ block: true }).range(r.from, r.to));
    if (m.mode === "mixed" && !hide && r.presentation)
      result.push(
        Decoration.widget({
          widget: new RegionWidget(r, true, signature),
          block: true,
          side: 1,
        }).range(r.to),
      );
  }
  return Decoration.set(result, true);
}
const initial = () => ({
  mode: "source",
  focus: false,
  regions: [],
  anchors: [],
  marks: new Set(),
  open: new Set(),
  bookmarks: new Map(),
  owner: null,
  diagnostics: [],
  checking: true,
  notice: "",
  blocked: false,
  seeded: false,
  decorations: Decoration.none,
});
export const displayField = StateField.define({
  create: initial,
  update(old, tr) {
    const m = {
      ...old,
      marks: new Set(old.marks),
      open: new Set(old.open),
      bookmarks: new Map(old.bookmarks),
    };
    if (tr.docChanged) {
      m.anchors = old.anchors
        .filter((r) => {
          let removed = false;
          tr.changes.iterChangedRanges((a, b) => {
            if (a <= r.from && b >= r.to) removed = true;
          });
          return !removed;
        })
        .map((r) => ({
          ...r,
          from: tr.changes.mapPos(r.from, 1),
          to: tr.changes.mapPos(r.to, -1),
        }));
      for (const [key, selection] of m.bookmarks)
        m.bookmarks.set(key, selection.map(tr.changes));
      m.regions = [];
      m.owner = null;
      m.diagnostics = [];
      m.checking = true;
      m.notice = "Source changed; old presentations withdrawn.";
    }
    if (tr.selection) m.owner = null;
    for (const effect of tr.effects)
      if (effect.is(displayEffect)) {
        const e = effect.value;
        if (e.type === "mode") m.mode = e.mode;
        if (e.type === "focus") m.focus = e.value;
        if (e.type === "message") m.notice = e.text;
        if (e.type === "mark") {
          m.marks.has(e.key) ? m.marks.delete(e.key) : m.marks.add(e.key);
        }
        if (e.type === "open") {
          for (const key of e.keys) m.open.add(key);
          m.owner = null;
          m.notice = e.text ?? "Source revealed.";
          m.blocked = !!e.blocked;
        }
        if (e.type === "owner") m.owner = e.key;
        if (e.type === "return") {
          m.bookmarks.set(e.key, e.selection);
          m.open.delete(e.key);
          m.owner = e.key;
          m.notice =
            "Display restored; Edit source restores the source selection.";
        }
        if (e.type === "keyup") m.blocked = false;
        if (e.type === "clear") {
          m.regions = [];
          m.owner = null;
          m.checking = true;
          m.diagnostics = [];
        }
        if (e.type === "diagnostics") {
          m.diagnostics = e.items;
          m.checking = false;
        }
        if (e.type === "snapshot") {
          // Accept only full-line commands. Same-line multi-command cases stay source.
          const regions = e.regions
            .filter(
              (r) => r.from >= 0 && r.to <= tr.newDoc.length && r.from < r.to,
            )
            .filter((r) => {
              const a = tr.newDoc.lineAt(r.from),
                b = tr.newDoc.lineAt(r.to);
              return (
                !tr.newDoc.sliceString(a.from, r.from).trim() &&
                !tr.newDoc.sliceString(r.to, b.to).trim()
              );
            })
            .map((r) => ({
              ...r,
              from: tr.newDoc.lineAt(r.from).from,
              to: tr.newDoc.lineAt(r.to).to,
            }));
          const same = new Set(
            regions
              .filter((r) =>
                m.anchors.some(
                  (a) => a.key === r.key && a.from === r.from && a.to === r.to,
                ),
              )
              .map((r) => r.key),
          );
          // A pending suffix has no identity evidence yet. Preserve its mapped
          // preferences until a complete snapshot can confirm or reject them.
          const known = new Set(regions.map((r) => r.key));
          const retain = (key) =>
            same.has(key) || (!e.complete && !known.has(key));
          const lost = [...m.marks].some((key) => !retain(key));
          m.marks = new Set([...m.marks].filter(retain));
          m.open = new Set([...m.open].filter(retain));
          m.bookmarks = new Map(
            [...m.bookmarks].filter(([key]) => retain(key)),
          );
          if (!m.seeded && e.complete) {
            for (const r of regions)
              if (["identity_eq", "local_eq"].includes(r.name))
                m.marks.add(r.key);
            m.seeded = true;
          }
          m.regions = regions;
          m.anchors = e.complete
            ? regions
            : [...regions, ...m.anchors.filter((r) => !known.has(r.key))];
          if (lost)
            m.notice =
              "A changed declaration lost its contribution correspondence; review the marks.";
          else if (
            e.complete &&
            m.notice === "Source changed; old presentations withdrawn."
          )
            m.notice = "";
        }
      }
    m.decorations = decorations(m, { selection: tr.newSelection });
    return m;
  },
  provide: (field) => EditorView.decorations.from(field, (m) => m.decorations),
});
function mutationGuard(tr) {
  if (
    !tr.docChanged ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo") ||
    tr.annotation(Transaction.remote)
  )
    return tr;
  const m = tr.startState.field(displayField),
    hidden = hiddenRegions(m, tr.startState.selection),
    keys = new Set();
  tr.changes.iterChangedRanges((a, b) => {
    for (const r of hidden) if (hits(a, b, r)) keys.add(r.key);
  });
  if (tr.isUserEvent("delete"))
    for (const selection of tr.startState.selection.ranges) {
      if (!selection.empty) continue;
      for (const r of hidden)
        if (
          (tr.isUserEvent("delete.backward") && selection.head === r.to + 1) ||
          (tr.isUserEvent("delete.forward") && selection.head === r.from - 1)
        )
          keys.add(r.key);
    }
  if (!keys.size) return tr;
  return {
    effects: displayEffect.of({
      type: "open",
      keys: [...keys],
      blocked: tr.isUserEvent("delete"),
      text: "Hidden source revealed. Repeat the editing action to change it.",
    }),
    annotations: Transaction.addToHistory.of(false),
  };
}
const events = EditorView.domEventHandlers({
  focus(e, view) {
    if (
      e.target === view.contentDOM &&
      view.state.field(displayField).owner !== null
    )
      view.dispatch({
        effects: displayEffect.of({ type: "owner", key: null }),
      });
    return false;
  },
  keydown(e, view) {
    if (
      e.repeat &&
      ["Backspace", "Delete"].includes(e.key) &&
      view.state.field(displayField).blocked
    ) {
      e.preventDefault();
      return true;
    }
    return false;
  },
  keyup(e, view) {
    if (
      ["Backspace", "Delete"].includes(e.key) &&
      view.state.field(displayField).blocked
    )
      view.dispatch({ effects: displayEffect.of({ type: "keyup" }) });
    return false;
  },
  cut(e, view) {
    const m = view.state.field(displayField),
      hidden = hiddenRegions(m, view.state.selection),
      keys = new Set();
    for (const s of view.state.selection.ranges) {
      const from = s.empty ? view.state.doc.lineAt(s.head).from : s.from;
      const to = s.empty
        ? Math.min(view.state.doc.length, view.state.doc.lineAt(s.head).to + 1)
        : s.to;
      for (const r of hidden) if (hits(from, to, r)) keys.add(r.key);
    }
    if (!keys.size) return false;
    e.preventDefault();
    view.dispatch({
      effects: displayEffect.of({
        type: "open",
        keys: [...keys],
        text: "Source revealed; Cut again to cut the visible selection.",
      }),
    });
    return true;
  },
});
export const enrichment = [
  displayField,
  EditorState.allowMultipleSelections.of(true),
  Prec.highest(EditorState.transactionFilter.of(mutationGuard)),
  Prec.highest(events),
];
