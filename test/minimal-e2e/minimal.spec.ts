import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const missingPrerequisites = ["lean", "lake"].filter(
  (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0,
);

test.skip(
  missingPrerequisites.length > 0,
  `Lean is required for the minimal browser example: missing ${missingPrerequisites.join(", ")}.`,
);

test("minimal example starts, diagnoses, follows the cursor, and reconnects", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");

  const statusValue = (kind: string) =>
    page.locator(`[data-platform-status-part="value"][data-platform-status-kind="${kind}"]`);
  await expect(statusValue("status")).toHaveText("Ready");
  await expect(statusValue("document")).toContainText("Helper.lean");
  await expect(page.locator("#minimal-editor .cm-content")).toContainText("def helperValue");
  await expect(page.locator("#lean-generation")).toHaveText("Generation 1");

  const content = page.locator("#minimal-editor .cm-content");
  await content.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect(page.locator("#lean-infoview")).toContainText("Helper.lean:3:6");
  await expect(page.locator("#lean-infoview")).toContainText("Expected type");
  await expect(page.locator("#lean-infoview")).toContainText("Nat");

  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n#check MissingLeanName");
  await expect(page.locator("#minimal-editor .cm-lintRange-error")).not.toHaveCount(0);
  await expect(statusValue("diagnostics")).toContainText("1 error");

  await page.locator("#restart-lean").click();
  await expect(page.locator("#lean-generation")).toHaveText("Generation 2");
  await expect(statusValue("status")).toHaveText("Ready");
  await expect(content).toContainText("#check MissingLeanName");
  await expect(page.locator("#lean-infoview")).toContainText("Helper.lean");
  expect(consoleErrors).toEqual([]);
});
