import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const leanAvailable = spawnSync("lean", ["--version"], { stdio: "ignore" }).status === 0;

test.skip(!leanAvailable, "Lean is required for the browser E2E test.");

test("demo supports undo and cross-file navigation", async ({ page }) => {
  const insertedSnippet = "#check demo";

  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#document-uri")).toContainText("Main.lean");

  const editor = page.locator(".cm-content");
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
