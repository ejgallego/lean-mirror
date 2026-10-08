import { expect, test, type WebSocketRoute } from "@playwright/test";

const backend = process.env.PACKED_BROWSER_CONSUMER_ROOT
  ? `http://${process.env.PACKED_BACKEND_HOST ?? "127.0.0.1"}:${process.env.PACKED_BACKEND_PORT ?? "7470"}`
  : `http://${process.env.WORKSPACE_BACKEND_HOST ?? "127.0.0.1"}:${process.env.WORKSPACE_BACKEND_PORT ?? "7461"}`;
const pagePath = process.env.WORKSPACE_BROWSER_PATH ?? "/";
const original = new Map<string, string>();
test.beforeEach(async ({ request }) => {
  const session = await (await request.get(backend + "/session")).json();
  for (const uri of session.documents as string[]) {
    if (!uri.endsWith("/Main.lean") && !uri.endsWith("/Helper.lean")) continue;
    const snapshot = await (await request.get(backend + "/lean-document?uri=" + encodeURIComponent(uri))).json();
    original.set(uri, snapshot.text);
  }
});
test.afterEach(async ({ request }) => {
  for (const [uri, text] of original) {
    const snapshot = await (await request.get(backend + "/lean-document?uri=" + encodeURIComponent(uri))).json();
    const response = await request.post(backend + "/lean-document", { data: { ...snapshot, text } });
    expect(response.ok()).toBe(true);
  }
  original.clear();
});

test("navigates across files, preserves edits and undo on server loss, and persists both files", async ({ page }) => {
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.routeWebSocket(/\/lsp$/, (route) => { sockets.push({ client: route, server: route.connectToServer() }); });
  await page.goto(pagePath);
  await expect(page.locator("#connection-status")).toHaveText("Ready");
  const content = page.locator("#workspace-editor .workspace-editor-panel:not([hidden]) .cm-content");
  await expect(page.locator("#active-file")).toHaveText("Main.lean");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n-- main unsaved");
  const mainElement = await content.elementHandle();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F12");
  await expect(page.locator("#active-file")).toHaveText("Helper.lean");
  await expect(content).toContainText("def helperValue");
  await expect(content).toBeFocused();
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n-- helper unsaved");
  const helperElement = await content.elementHandle();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("#workspace-infoview")).toContainText("Expected type");
  await expect(page.locator("#workspace-infoview")).toContainText("Nat");

  // Terminate the real server-side transport. Its bridge shuts down the old Lean process.
  await Promise.all([
    sockets[0]!.server.close({ code: 1011, reason: "Server transport failure" }),
    sockets[0]!.client.close({ code: 1011, reason: "Server transport failure" }),
  ]);
  await expect(page.locator("#connection-status")).toHaveAttribute("data-generation", "2");
  await expect(page.locator("#connection-status")).toHaveText("Ready");
  expect(await helperElement!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(content).toContainText("-- helper unsaved");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n#check MissingAfterRecovery");
  await expect(content.locator("..").locator(".cm-lintRange-error")).not.toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(content).not.toContainText("MissingAfterRecovery");
  await expect(content.locator("..").locator(".cm-lintRange-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Main.lean", exact: false }).click();
  expect(await mainElement!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(content).toContainText("-- main unsaved");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+z");
  await expect(content).not.toContainText("-- main unsaved");
  await page.keyboard.press("Control+Shift+z");
  await expect(content).toContainText("-- main unsaved");
  await page.getByRole("button", { name: "Save all" }).click();
  await expect(page.locator("#save-status")).toHaveText("All changes saved");
  await page.reload();
  await expect(page.locator("#connection-status")).toHaveText("Ready");
  await expect(content).toContainText("-- main unsaved");
  await page.getByRole("button", { name: "Helper.lean", exact: false }).click();
  await expect(content).toContainText("-- helper unsaved");
  expect(pageErrors).toEqual([]);
});

test("keeps local edits when another client changes the disk revision", async ({ page, request }) => {
  await page.goto(pagePath);
  await expect(page.locator("#connection-status")).toHaveText("Ready");
  const content = page.locator("#workspace-editor .workspace-editor-panel:not([hidden]) .cm-content");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n-- local edit kept");
  const main = [...original.keys()].find((uri) => uri.endsWith("/Main.lean"))!;
  const snapshot = await (await request.get(backend + "/lean-document?uri=" + encodeURIComponent(main))).json();
  expect((await request.post(backend + "/lean-document", { data: { ...snapshot, text: snapshot.text + "\n-- external edit" } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Save all" }).click();
  await expect(page.locator("#save-status")).toContainText("File changed on disk");
  await expect(content).toContainText("-- local edit kept");
  const saved = await (await request.get(backend + "/lean-document?uri=" + encodeURIComponent(main))).json();
  expect(saved.text).toContain("-- external edit");
  expect(saved.text).not.toContain("-- local edit kept");
});

test("keeps edits made while a save response is in flight dirty until they are saved", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let savedOnDisk = false;
  await page.route("**/lean-document", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    savedOnDisk = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(pagePath);
    await expect(page.locator("#connection-status")).toHaveText("Ready");
    const content = page.locator("#workspace-editor .workspace-editor-panel:not([hidden]) .cm-content");
    await content.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n-- first save");
    await page.getByRole("button", { name: "Save all" }).click();
    await expect.poll(() => savedOnDisk).toBe(true);
    await content.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n-- edited during save");
    release();
    await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
    await expect(page.getByRole("button", { name: "Save all" })).toBeEnabled();
    await page.getByRole("button", { name: "Save all" }).click();
    await expect(page.locator("#save-status")).toHaveText("All changes saved");
    await page.reload();
    await expect(content).toContainText("-- edited during save");
  } finally {
    release();
  }
});
