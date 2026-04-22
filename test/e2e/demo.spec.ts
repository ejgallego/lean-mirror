import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const leanAvailable = spawnSync("lean", ["--version"], { stdio: "ignore" }).status === 0;

test.skip(!leanAvailable, "Lean is required for the browser E2E test.");

test("demo supports undo and cross-file navigation", async ({ page }) => {
  const insertedSnippet = "#check demo";

  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#document-uri")).toContainText("Main.lean");

  const editor = page.locator("#editor > .cm-editor > .cm-scroller > .cm-content");
  await editor.click();
  await page.keyboard.type(`\n${insertedSnippet}`);

  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain(insertedSnippet);

  expect(await page.evaluate(() => window.__leanDemo?.undo())).toBe(true);

  await expect
    .poll(async () => (await page.evaluate(() => window.__leanDemo?.currentDoc()))?.includes(insertedSnippet))
    .toBe(false);

  await page.getByRole("button", { name: "Helper.lean" }).click();
  await expect(page.locator("#document-uri")).toContainText("Helper.lean");
  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("def helperValue");
});

test("demo opens and syncs the embedded Rust widget", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  const expandedBlock = page.locator(".cm-embedded-block-widget").first();
  await expect(expandedBlock).toHaveCount(1);
  await expect(expandedBlock.locator(".cm-embedded-block-inline .cm-editor")).toHaveCount(1);

  const nestedEditor = expandedBlock.locator(".cm-embedded-block-inline .cm-content");
  await nestedEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nfn mul(a: i32, b: i32) -> i32 {\n    a * b\n}");

  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("-- fn mul(a: i32, b: i32) -> i32 {");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await expect(expandedBlock.locator(".cm-embedded-block-inline .cm-content")).toContainText("a - b");
});

test("demo toggles embedded widgets on and off", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  await page.getByRole("button", { name: "Disable widgets" }).click();
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("```rust demo-widget");
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(false);
  await expect(page.locator(".cm-content")).toContainText("a + b");

  await page.getByRole("button", { name: "Enable widgets" }).click();
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);
});
