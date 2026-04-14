import { undo } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";

import { createTestView } from "./support/helpers.js";
import { leanUtilities } from "../src/index.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("leanUtilities", () => {
  it("provides history-backed undo support", () => {
    const view = createTestView("def x := 1", leanUtilities());

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n#check x" } });
    expect(view.state.doc.toString()).toContain("#check x");

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).not.toContain("#check x");

    view.destroy();
  });
});
