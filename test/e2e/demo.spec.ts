import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

function commandAvailable(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

const missingPrerequisites = ["lean", "lake", "rust-analyzer"].filter(
  (command) => !commandAvailable(command),
);

function isExpectedTransientConsoleError(text: string): boolean {
  return (
    text.includes("net::ERR_CONNECTION_REFUSED") ||
    (text.includes("WebSocket connection to") && text.includes("failed:"))
  );
}

test.skip(
  missingPrerequisites.length > 0,
  `Lean demo prerequisites are required for the browser E2E test: missing ${missingPrerequisites.join(", ")}.`,
);

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isExpectedTransientConsoleError(message.text())) {
      errors.push(message.text());
    }
  });
  await page.exposeFunction("__consumeConsoleErrors", () => {
    const snapshot = [...errors];
    errors.length = 0;
    return snapshot;
  });
});

async function clickButtonByText(page: Page, text: string) {
  await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label ||
        candidate.textContent?.trim() === label ||
        candidate.title === label,
    );
    if (!button) {
      throw new Error(`Missing button: ${label}`);
    }
    button.click();
  }, text);
}

async function hasButtonByText(page: Page, text: string) {
  return page.evaluate((label) => {
    return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
      (candidate) =>
        candidate.getAttribute("aria-label") === label ||
        candidate.textContent?.trim() === label ||
        candidate.title === label,
    );
  }, text);
}

async function hasHighlightedToken(page: Page, selector: string, text: string) {
  return page.evaluate(
    ({ selector: tokenSelector, text: tokenText }) =>
      Array.from(document.querySelectorAll<HTMLElement>(tokenSelector)).some(
        (token) => token.textContent === tokenText && token.className.trim().length > 0,
      ),
    { selector, text },
  );
}

function waitForRustWidgetSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/rust-document") &&
      response.ok(),
  );
}

test("demo supports undo and cross-file navigation", async ({ page }) => {
  const insertedSnippet = "#check demo";

  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#document-uri")).toContainText("Main.rs");

  await page.getByRole("button", { name: "Main.lean" }).click();
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
  await page.getByRole("button", { name: "Main.lean" }).click();
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  const expandedBlock = page.locator(".cm-embedded-block-widget").first();
  await expect(expandedBlock).toHaveCount(1);
  await expect(expandedBlock.locator(".cm-embedded-block-inline .cm-editor")).toHaveCount(1);

  const nestedEditor = expandedBlock.locator(".cm-embedded-block-inline .cm-content");
  await nestedEditor.click();
  await page.keyboard.press("Control+End");
  const saved = waitForRustWidgetSave(page);
  await page.keyboard.type("\nfn mul(a: i32, b: i32) -> i32 {\n    a * b\n}");

  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("fn mul(a: i32, b: i32) -> i32 {");
  await saved;

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await expect(expandedBlock.locator(".cm-embedded-block-inline .cm-content")).toContainText("a - b");
});

test("demo toggles embedded widgets on and off", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Main.lean" }).click();
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  for (let i = 0; i < 2; i += 1) {
    await clickButtonByText(page, "Disable widget");
    await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
    await expect.poll(() => hasButtonByText(page, "Enable widget")).toBe(true);
    await expect(page.locator(".cm-content")).toContainText("/-!");
    await expect(page.locator(".cm-content")).toContainText("```rust demo-widget");
    expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(false);
    await expect(page.locator(".cm-content")).toContainText("a + b");

    await clickButtonByText(page, "Enable widget");
  }

  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("demo inserts a Rust scaffold from the gutter", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Main.lean" }).click();
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  await clickButtonByText(page, "Add Rust");

  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("```rust demo-widget-2");

  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(2);
});

test("demo opens the Rust driver and refreshes embedded Lean snippets", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#document-uri")).toContainText("Main.rs");
  await expect(page.locator("#events")).toContainText("rust-analyzer initialized.");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("```lean demo-check");

  await expect(page.locator("#events")).toContainText("Rust driver saved; Lean snippets refreshed.");
});

test("demo highlights Rust and embedded Lean code", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#document-uri")).toContainText("Main.rs");
  await expect.poll(() => hasHighlightedToken(page, "#editor > .cm-editor .cm-line span", "pub")).toBe(true);
  await expect
    .poll(() => hasHighlightedToken(page, ".cm-embedded-block-widget .cm-line span", "#check"))
    .toBe(true);
});

test("demo updates Rust and embedded Lean diagnostics after edits", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("rust-analyzer initialized.");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "\"bad\""))).toBe(true);
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).not.toHaveCount(0);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("\"bad\"", "a + b"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("a + b");
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).toHaveCount(0);

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("Nat.succ", "MissingLeanName"))).toBe(true);
  await expect(page.locator(".cm-embedded-block-widget .cm-lintRange-error")).not.toHaveCount(0);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("MissingLeanName", "Nat.succ"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("Nat.succ");
  await expect(page.locator(".cm-embedded-block-widget .cm-lintRange-error")).toHaveCount(0);
  await page.waitForTimeout(900);
});

test("demo updates Rust diagnostics after keyboard edits", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("rust-analyzer initialized.");

  await page
    .locator("#editor > .cm-editor .cm-line")
    .filter({ hasText: "a + b" })
    .first()
    .click();
  await page.keyboard.press("End");
  await page.keyboard.type(" +");
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).not.toHaveCount(0);

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b +", "a + b"))).toBe(true);
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).toHaveCount(0);
  await page.waitForTimeout(900);
});
