// Real CodeMirror and native Lean tests for the in-place interaction slice.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const original = await readFile(resolve(root, "Fixture.lean"), "utf8");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  permissions: ["clipboard-read", "clipboard-write"],
  viewport: { width: 1440, height: 1100 },
});
const errors = [];
const url = process.env.SNAPSHOT_DEMO_URL ?? "http://127.0.0.1:5282";
async function open(crlf = false) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  if (crlf)
    await page.route("**/session", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.source = data.source.replaceAll("\n", "\r\n");
      await route.fulfill({ response, json: data });
    });
  await page.goto(url);
  await complete(page);
  return page;
}
async function complete(page) {
  await expect(page.locator("#outline")).toHaveAttribute(
    "data-snapshot-status",
    "complete",
    { timeout: 45000 },
  );
}
// The test imports the experiment modules to inspect the actual editor state and
// place exact source selections; editing itself uses real keyboard/clipboard paths.
async function inspect(page) {
  return page.evaluate(async () => {
    const { getEditor } = await import("/main.js");
    const { displayField } = await import("/enrichment.js");
    const view = getEditor(),
      m = view.state.field(displayField);
    const hidden = [];
    m.decorations.between(0, view.state.doc.length, (from, to) => {
      if (to > from) hidden.push({ from, to });
    });
    return {
      source: view.state.doc.toString(),
      selection: view.state.selection.toJSON(),
      hidden,
      regions: m.regions,
      open: [...m.open],
      marks: [...m.marks],
      owner: m.owner,
      notice: m.notice,
    };
  });
}
async function select(page, ranges) {
  await page.evaluate(async (ranges) => {
    const { getEditor } = await import("/main.js");
    const EditorSelection = getEditor().state.selection.constructor;
    getEditor().dispatch({
      selection: EditorSelection.create(
        ranges.map((s) => EditorSelection.range(s.anchor, s.head ?? s.anchor)),
      ),
      scrollIntoView: true,
    });
    getEditor().focus();
  }, ranges);
}
async function selection(page, anchor, head = anchor) {
  return select(page, [{ anchor, head }]);
}
async function sourceMode(page) {
  await page.selectOption("#presentation", "source");
  await page.locator("#focus-contributions").uncheck();
}
async function rendered(page) {
  await selection(page, 0);
  await page.selectOption("#presentation", "rendered");
}
async function header(page, name) {
  const state = await inspect(page),
    r = state.regions.find((r) => r.name === name);
  assert(r, `region ${name}`);
  // Scroll without placing a caret in the hidden source.
  await page.evaluate(async (pos) => {
    const { getEditor } = await import("/main.js");
    const view = getEditor();
    view.dispatch({
      effects: view.constructor.scrollIntoView(pos, { y: "center" }),
    });
  }, r.from);
  return page.locator(".enrich-header").filter({
    has: page.locator(".enrich-title", { hasText: new RegExp(`^${name}$`) }),
  });
}
try {
  const p = await open();
  let state = await inspect(p);
  assert.equal(state.regions.length, 5);
  assert.equal(state.marks.length, 2);
  const r = (name) => state.regions.find((r) => r.name === name);
  const a = r("identity_eq"),
    h = r("helper"),
    z = r("local_eq");
  // A partial worker result must not erase preferences in its pending suffix.
  await p.evaluate(async () => {
    const { getEditor } = await import("/main.js");
    const { displayField, displayEffect } = await import("/enrichment.js");
    const v = getEditor(),
      before = v.state.field(displayField),
      regions = before.regions;
    const marks = [...before.marks].join();
    v.dispatch({
      effects: displayEffect.of({
        type: "snapshot",
        regions: regions.slice(0, 2),
        complete: false,
      }),
    });
    if ([...v.state.field(displayField).marks].join() !== marks)
      throw new Error("Partial result erased a later mark");
    v.dispatch({
      effects: displayEffect.of({ type: "snapshot", regions, complete: true }),
    });
    if ([...v.state.field(displayField).marks].join() !== marks)
      throw new Error("Complete result lost pending identity");
  });
  // Mixed companion and Rendered replacement are decorations over one document.
  await p.selectOption("#presentation", "mixed");
  await expect(p.locator(".enrich-companion").first()).toBeVisible();
  assert.equal((await inspect(p)).source, original);
  await rendered(p);
  assert((await inspect(p)).hidden.length >= 3);
  let card = await header(p, "identity_eq");
  await card.getByRole("button", { name: "Edit source", exact: true }).click();
  await selection(p, a.presentation.statement.from + 8);
  const remembered = (await inspect(p)).selection;
  await card
    .getByRole("button", { name: "Return to display", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Edit source", exact: true }),
  ).toBeFocused();
  assert.equal((await inspect(p)).owner, a.key);
  const before = (await inspect(p)).source;
  await p.keyboard.type("xyz");
  assert.equal((await inspect(p)).source, before);
  await p.keyboard.press("Enter");
  assert.deepEqual((await inspect(p)).selection, remembered);
  // Cross-region secondary selections forbid closing a local source edit.
  await select(p, [{ anchor: a.from + 1 }, { anchor: z.from + 1 }]);
  card = await header(p, "identity_eq");
  await card
    .getByRole("button", { name: "Return to display", exact: true })
    .click();
  await expect(p.locator("#interaction-status")).toContainText(
    "Narrow all source selections",
  );
  await selection(p, a.from + 1);
  await card
    .getByRole("button", { name: "Return to display", exact: true })
    .click();
  // Whole-region selection owns clipboard scope, never a hidden proof.
  await card
    .getByRole("button", {
      name: /^Select whole Lean statement: identity_eq\./,
    })
    .click();
  await p.keyboard.press("ControlOrMeta+c");
  assert.equal(
    await p.evaluate(() => navigator.clipboard.readText()),
    a.presentation.header,
  );
  await card
    .getByRole("button", { name: "Copy rendered mathematics", exact: true })
    .click();
  assert.equal(
    await p.evaluate(() => navigator.clipboard.readText()),
    `${a.presentation.context}; ${a.presentation.math}`,
  );
  await p.evaluate(() => navigator.clipboard.writeText("clipboard sentinel"));
  await p.keyboard.press("ControlOrMeta+x");
  assert.equal((await inspect(p)).source, before);
  assert.equal(
    await p.evaluate(() => navigator.clipboard.readText()),
    "clipboard sentinel",
  );
  assert.deepEqual((await inspect(p)).selection.ranges, [
    {
      anchor: a.presentation.statement.from,
      head: a.presentation.statement.to,
    },
  ]);
  // Full intervals, including secondary selections and Select All, reveal helpers.
  await p.locator("#focus-contributions").check();
  await selection(p, a.from, z.to);
  assert(
    !(await inspect(p)).hidden.some((x) => x.from <= h.from && x.to >= h.to),
  );
  await select(p, [{ anchor: 0 }, { anchor: a.from, head: z.to }]);
  assert(
    !(await inspect(p)).hidden.some((x) => x.from < z.to && x.to > a.from),
  );
  await p.keyboard.press("ControlOrMeta+a");
  assert.equal((await inspect(p)).hidden.length, 0);
  await p.keyboard.press("ControlOrMeta+c");
  assert.equal(
    await p.evaluate(() => navigator.clipboard.readText()),
    original,
  );
  // Manual membership and local expansion remain independent of presentation.
  await selection(p, 0);
  const helperCard = await header(p, "helper");
  await helperCard
    .getByRole("button", { name: "Mark contribution", exact: true })
    .click();
  assert.equal((await inspect(p)).marks.length, 3);
  await helperCard
    .getByRole("button", { name: "Edit source", exact: true })
    .click();
  await p.selectOption("#presentation", "mixed");
  await expect(helperCard).toHaveAttribute("data-hidden-source", "false");
  await p.selectOption("#presentation", "rendered");
  await expect(helperCard).toHaveAttribute("data-hidden-source", "false");
  await helperCard
    .getByRole("button", { name: "Return to display", exact: true })
    .click();
  await helperCard
    .getByRole("button", { name: /^Select whole Lean statement: helper\./ })
    .click();
  await p.keyboard.down("Backspace");
  assert.equal((await inspect(p)).source, original);
  await p.keyboard.down("Backspace");
  assert.equal((await inspect(p)).source, original);
  await p.keyboard.up("Backspace");
  await expect(p.getByRole("textbox", { name: "Lean source" })).toBeFocused();
  await p.close();
  console.log(
    "PASS: presentations, bookmarks/focus, region clipboard, full and multiple selections",
  );

  // Fresh contexts avoid local reveal preferences masking replacement-boundary cases.
  for (const operation of ["cut", "delete", "paste", "type"]) {
    const page = await open();
    await rendered(page);
    await page.locator("#focus-contributions").check();
    const s = await inspect(page),
      first = s.regions.find((x) => x.name === "identity_eq"),
      last = s.regions.find((x) => x.name === "local_eq");
    await selection(page, first.from, last.to);
    assert.equal(
      (await inspect(page)).hidden.filter(
        (x) => x.from < last.to && x.to > first.from,
      ).length,
      0,
    );
    if (operation === "paste")
      await page.evaluate(() =>
        navigator.clipboard.writeText("-- replaced selection"),
      );
    if (operation === "type") await page.keyboard.type("-- typed selection");
    else
      await page.keyboard.press(
        operation === "cut"
          ? "ControlOrMeta+x"
          : operation === "paste"
            ? "ControlOrMeta+v"
            : "Delete",
      );
    const inserted =
      operation === "paste"
        ? "-- replaced selection"
        : operation === "type"
          ? "-- typed selection"
          : "";
    assert.equal(
      (await inspect(page)).source,
      original.slice(0, first.from) + inserted + original.slice(last.to),
    );
    if (operation === "cut")
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        original.slice(first.from, last.to),
      );
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal((await inspect(page)).source, original);
    await page.close();
  }
  console.log("PASS: cross-helper cut/delete/paste/typing and undo");

  const boundary = await open();
  await rendered(boundary);
  state = await inspect(boundary);
  const helper = state.regions.find((x) => x.name === "helper");
  await select(boundary, [{ anchor: helper.from - 1 }, { anchor: 1 }]);
  const boundarySource = (await inspect(boundary)).source;
  await boundary.keyboard.down("Delete");
  assert.equal((await inspect(boundary)).source, boundarySource);
  await boundary.keyboard.down("Delete");
  assert.equal((await inspect(boundary)).source, boundarySource);
  await boundary.keyboard.up("Delete");
  await boundary.keyboard.press("Delete");
  assert.notEqual((await inspect(boundary)).source, boundarySource);
  await boundary.keyboard.press("ControlOrMeta+z");
  assert.equal((await inspect(boundary)).source, original);
  await complete(boundary);
  await sourceMode(boundary);
  // A context-only edit must retire unchanged theorems' supplied mathematics.
  let start = original.indexOf("Nat", original.indexOf("local notation"));
  await selection(boundary, start, start + 3);
  await boundary.keyboard.insertText("Int");
  assert.equal((await inspect(boundary)).regions.length, 0);
  await complete(boundary);
  assert((await inspect(boundary)).regions.every((x) => !x.presentation));
  await boundary.keyboard.press("ControlOrMeta+z");
  await complete(boundary);
  await expect
    .poll(
      async () =>
        (await inspect(boundary)).regions.filter((r) => r.presentation).length,
      { timeout: 45000 },
    )
    .toBe(3);
  // Real proof feedback remains available independently of presentation.
  start = original.indexOf("  rfl");
  await selection(boundary, start, start + 5);
  await boundary.keyboard.insertText("  exact does_not_exist");
  await expect(boundary.locator("#diagnostics")).toContainText(
    "Unknown identifier `does_not_exist`",
    { timeout: 45000 },
  );
  await expect(boundary.locator(".cm-lintRange-error")).not.toHaveCount(0);
  await boundary.keyboard.press("ControlOrMeta+z");
  await expect(boundary.locator("#diagnostics")).toContainText(
    "No diagnostics reported",
    { timeout: 45000 },
  );
  await complete(boundary);
  // An admitted supporting declaration carries actual Lean warning feedback,
  // including while collapsed. Diagnostic navigation opens that exact source.
  const pending =
    "\n/-- Work in progress. -/\ntheorem pending : True := by sorry\n";
  start = original.lastIndexOf("end DisplayFixture");
  await selection(boundary, start);
  await boundary.keyboard.insertText(pending);
  await expect(boundary.locator("#diagnostics")).toContainText("sorry", {
    timeout: 45000,
  });
  await complete(boundary);
  await selection(boundary, 0);
  await boundary.locator("#focus-contributions").check();
  const pendingHeader = await header(boundary, "pending");
  await expect(pendingHeader).toHaveAttribute("data-hidden-source", "true");
  await expect(pendingHeader).toContainText("1 diagnostic(s)");
  await boundary
    .locator("#diagnostics p")
    .filter({ hasText: "sorry" })
    .getByRole("button", { name: "Reveal diagnostic" })
    .click();
  await expect(pendingHeader).toHaveAttribute("data-hidden-source", "false");
  await boundary.keyboard.press("ControlOrMeta+z");
  await complete(boundary);
  await sourceMode(boundary);
  // Real Lean hover remains available with the in-place decorations installed.
  await selection(boundary, 0);
  const point = await boundary
    .locator(".cm-line")
    .filter({ hasText: "def identity" })
    .evaluate((line) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        const offset = node.textContent.indexOf("identity");
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 8);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      throw new Error("Identifier not visible");
    });
  await boundary.mouse.move(point.x, point.y);
  await expect(boundary.locator(".cm-tooltip-hover")).toBeVisible({
    timeout: 15000,
  });
  await boundary.mouse.move(0, 0);
  await boundary.close();
  console.log(
    "PASS: guarded boundary/multiple-cursor deletion, repeat protection, context invalidation, Lean diagnostics",
  );

  const unicode = await open(true);
  state = await inspect(unicode);
  assert.equal(state.source, original);
  assert(state.source.includes("😀"));
  for (const region of state.regions)
    if (region.presentation) {
      const { from, to } = region.presentation.statement;
      assert.equal(state.source.slice(from, to), region.presentation.header);
    }
  await rendered(unicode);
  card = await header(unicode, "local_eq");
  await card.getByRole("button", { name: "Edit source", exact: true }).click();
  assert.equal(
    (await inspect(unicode)).selection.ranges[0].anchor,
    state.regions.find((r) => r.name === "local_eq").from,
  );
  await sourceMode(unicode);
  await selection(unicode, 0);
  await unicode.keyboard.insertText("-- 😀 prefix\n");
  await complete(unicode);
  assert((await inspect(unicode)).regions.every((r) => !r.presentation));
  await unicode.keyboard.press("ControlOrMeta+z");
  await complete(unicode);
  await expect
    .poll(
      async () =>
        (await inspect(unicode)).regions.filter((r) => r.presentation).length,
      { timeout: 45000 },
    )
    .toBe(3);
  await rendered(unicode);
  await unicode.locator("#focus-contributions").check();
  await unicode.screenshot({
    path: resolve(root, "demo-desktop.png"),
    fullPage: true,
  });
  await unicode.setViewportSize({ width: 390, height: 844 });
  assert(
    await unicode.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const mobileHeader = await header(unicode, "identity_eq");
  await expect(
    mobileHeader.getByRole("button", {
      name: "Show proof with source",
      exact: true,
    }),
  ).toBeInViewport();
  assert(await mobileHeader.evaluate((el) => el.scrollWidth <= el.clientWidth));
  await unicode.screenshot({
    path: resolve(root, "demo-mobile.png"),
    fullPage: true,
  });
  await unicode.close();
  assert.equal(await readFile(resolve(root, "Fixture.lean"), "utf8"), original);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: CRLF/non-BMP editor boundary, pre-region edit/undo, mobile, on-disk source preservation",
  );
} finally {
  await context.close();
  await browser.close();
}
