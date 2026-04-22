import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const leanAvailable = spawnSync("lean", ["--version"], { stdio: "ignore" }).status === 0;

test.skip(!leanAvailable, "Lean is required for the browser E2E test.");

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.exposeFunction("__consumeConsoleErrors", () => {
    const snapshot = [...errors];
    errors.length = 0;
    return snapshot;
  });
});

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
    .toContain("fn mul(a: i32, b: i32) -> i32 {");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await expect(expandedBlock.locator(".cm-embedded-block-inline .cm-content")).toContainText("a - b");

  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nfn bad() -> i32 { \"hi\" }");
  await expect(page.locator("#events")).toContainText("Saved demo-widget");
  await expect(page.locator("#events")).toContainText("Rust diagnostics updated");
  await expect(expandedBlock.locator(".cm-lintRange-error").first()).toBeVisible();
});

test("demo toggles embedded widgets on and off", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Disable widget" }).click();
    await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Enable widget" })).toHaveCount(1);
    await expect(page.locator(".cm-content")).toContainText("/-!");
    await expect(page.locator(".cm-content")).toContainText("```rust demo-widget");
    expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(false);
    await expect(page.locator(".cm-content")).toContainText("a + b");

    await page.getByRole("button", { name: "Enable widget" }).click();
  }

  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});
