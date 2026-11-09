// Selection/mutation regressions at the real CodeMirror transaction boundary.
// Browser tests additionally exercise DOM focus, clipboard and native Lean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { enrichment, displayField, displayEffect } from "./web/enrichment.js";

const source = "a\nhelper\nz\n";
const region = {
  key: "helper",
  name: "helper",
  from: 2,
  to: 8,
  docs: "",
  presentation: {
    header: "helper",
    math: "h",
    context: "",
    statement: { from: 2, to: 8 },
  },
};
function initial(selection = EditorSelection.single(0)) {
  let state = EditorState.create({
    doc: source,
    selection,
    extensions: enrichment,
  });
  return state.update({
    effects: [
      displayEffect.of({ type: "snapshot", regions: [region], complete: true }),
      displayEffect.of({ type: "mode", mode: "rendered" }),
    ],
  }).state;
}
function hidden(state) {
  const ranges = [];
  state.field(displayField).decorations.between(0, state.doc.length, (a, b) => {
    if (a < b) ranges.push([a, b]);
  });
  return ranges;
}
test("one hidden mutation cancels all changes and preserves every cursor", () => {
  const selection = EditorSelection.create([
    EditorSelection.cursor(0),
    EditorSelection.cursor(9),
  ]);
  const state = initial(selection);
  const tr = state.update({
    changes: [
      { from: 0, to: 1 },
      { from: 2, to: 8 },
    ],
    userEvent: "delete.selection",
  });
  assert.equal(tr.newDoc.toString(), source);
  assert.deepEqual(tr.newSelection.toJSON(), selection.toJSON());
  assert.equal(tr.annotation(Transaction.addToHistory), false);
  assert.deepEqual(hidden(tr.state), []);
  assert.equal(
    tr.state
      .update({ changes: { from: 2, to: 8 }, userEvent: "delete.selection" })
      .newDoc.toString(),
    "a\n\nz\n",
  );
});
test("both boundary deletion directions reveal before deleting", () => {
  for (const [head, from, to, userEvent] of [
    [1, 1, 2, "delete.forward"],
    [9, 8, 9, "delete.backward"],
  ]) {
    const tr = initial(EditorSelection.single(head)).update({
      changes: { from, to },
      userEvent,
    });
    assert.equal(tr.newDoc.toString(), source);
    assert.equal(tr.newSelection.main.head, head);
    assert.deepEqual(hidden(tr.state), []);
    assert.equal(tr.state.field(displayField).blocked, true);
  }
});
test("full intervals and secondary ranges protect hidden source", () => {
  const state = initial();
  assert.deepEqual(hidden(state), [[2, 8]]);
  for (const ranges of [
    [EditorSelection.range(1, 9)],
    [EditorSelection.cursor(0), EditorSelection.range(1, 9)],
  ]) {
    assert.deepEqual(
      hidden(state.update({ selection: EditorSelection.create(ranges) }).state),
      [],
    );
  }
});
test("an edit outside a declaration retires its presentation without losing its mark", () => {
  let state = initial().update({
    effects: displayEffect.of({ type: "mark", key: "helper" }),
  }).state;
  state = state.update({ changes: { from: 0, insert: "context\n" } }).state;
  assert.deepEqual(state.field(displayField).regions, []);
  assert.deepEqual([...state.field(displayField).marks], ["helper"]);
  state = state.update({
    effects: displayEffect.of({
      type: "snapshot",
      regions: [],
      complete: false,
    }),
  }).state;
  assert.deepEqual([...state.field(displayField).marks], ["helper"]);
  state = state.update({
    effects: displayEffect.of({
      type: "snapshot",
      regions: [{ ...region, from: 10, to: 16, presentation: null }],
      complete: true,
    }),
  }).state;
  assert.deepEqual([...state.field(displayField).marks], ["helper"]);
  assert.equal(state.field(displayField).regions[0].presentation, null);
});
