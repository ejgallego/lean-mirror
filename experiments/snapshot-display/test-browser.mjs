// Run against `node experiments/snapshot-display/serve.mjs`.
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL(".", import.meta.url));
const original = await readFile(resolve(root, "Fixture.lean"), "utf8");
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(process.env.SNAPSHOT_DEMO_URL ?? "http://127.0.0.1:5281");
  const outline = page.locator("#outline");
  const cards = outline.locator(":scope > .card");
  const complete = async () => {
    await expect(outline).toHaveAttribute("data-snapshot-status", "complete", {
      timeout: 45000,
    });
  };
  await complete();
  const initialVersion = Number(await outline.getAttribute("data-version"));
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toContainText("Identity", { ignoreCase: true });
  await cards
    .first()
    .getByText("Expand source / proof", { exact: true })
    .click();
  await expect(cards.first().locator("pre")).toBeVisible();
  await cards.first().getByRole("button", { name: "Locate in source" }).click();
  await expect(
    page.getByRole("textbox", { name: "Lean source" }),
  ).toBeFocused();
  await page.selectOption("#policy", "names");
  await complete();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("identity_eq");
  await page.locator("#names").fill("local_eq");
  await complete();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("local_eq");
  await outline.locator(".other > summary").click();
  await expect(outline.locator(".other .card").first()).toBeVisible();
  await page.selectOption("#policy", "all");
  await complete();
  assert((await cards.count()) > 3);
  await page.selectOption("#policy", "theorems");
  await complete();
  // A real source edit must invalidate the old view and update its source identity.
  const editor = page.getByRole("textbox", { name: "Lean source" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    original.replaceAll("identity_eq", "identity_visible"),
  );
  await expect(outline).toHaveAttribute(
    "data-version",
    String(initialVersion + 1),
    {
      timeout: 45000,
    },
  );
  await complete();
  await expect(cards.first()).toContainText("identity_visible");
  assert(
    !(await cards
      .first()
      .innerText()
      .then((text) => text.includes("identity_eq"))),
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(outline).toHaveAttribute(
    "data-version",
    String(initialVersion + 2),
    {
      timeout: 45000,
    },
  );
  await complete();
  await expect(cards.first()).toContainText("identity_eq");
  // A proof-only edit must produce Lean feedback even when the outline is unchanged.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    original.replace("  rfl", "  exact does_not_exist"),
  );
  await expect(page.locator("#diagnostics")).toContainText(
    "Unknown identifier `does_not_exist`",
    { timeout: 45000 },
  );
  await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
  await complete();
  await expect(cards.first()).toContainText("identity_eq");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#diagnostics")).toContainText(
    "No diagnostics reported",
    { timeout: 45000 },
  );
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await complete();
  // Hover over a known identifier in the source and require a real Lean tooltip.
  await page.keyboard.press("ControlOrMeta+Home");
  const point = await page
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
      throw new Error("Identifier missing from editor");
    });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".cm-tooltip-hover")).toBeVisible({
    timeout: 15000,
  });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: resolve(root, "demo-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("h1")).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: resolve(root, "demo-mobile.png"),
    fullPage: true,
  });
  assert.equal(await readFile(resolve(root, "Fixture.lean"), "utf8"), original);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: live snapshot demo, policies, expansion, source reveal, edits/undo, proof diagnostics/recovery, Lean hover, mobile layout, fixture preservation",
  );
} finally {
  await browser.close();
}
