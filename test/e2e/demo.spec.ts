import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

test.beforeEach(async ({ page, request }) => {
  const backend = `http://${process.env.DEMO_BACKEND_HOST ?? "127.0.0.1"}:${process.env.DEMO_BACKEND_PORT ?? "7360"}`;
  const session = await (await request.get(backend + "/session")).json();
  if (session.rootUri === new URL("../../demo/workspace", import.meta.url).href) {
    // Restore through the backend queue so a failed scenario cannot leave its
    // persisted Rust edit behind for the next one. External workspaces stay alone.
    const [code, leanDocument] = await Promise.all([
      readFile(new URL("../../demo/baseline/Main.rs", import.meta.url), "utf8"),
      readFile(new URL("../../demo/baseline/RustSnippets.lean", import.meta.url), "utf8"),
    ]);
    const restored = await request.post(backend + "/rust-main", {
      data: { uri: session.rustMainDocumentUri, diskRevision: session.rustMainDiskRevision, code, leanDocument, revision: 0 },
    });
    expect(restored.ok()).toBe(true);
  }
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

async function hoverSourceText(page: Page, lineText: string, name: string) {
  const line = page.locator("#editor > .cm-editor .cm-line").filter({ hasText: lineText }).first();
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element, text) => {
    const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const index = node.textContent?.indexOf(text) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`Missing source text ${text}`);
  }, name);
  await page.mouse.move(point.x, point.y);
}

function statusValue(page: Page, kind: string) {
  return page.locator(`[data-platform-status-part="value"][data-platform-status-kind="${kind}"]`);
}

async function openDocument(page: Page, name: string) {
  const button = page.getByRole("button", { name }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(statusValue(page, "document")).toContainText(name, { timeout: 30_000 });
}

async function openDocumentContaining(page: Page, name: string, text: string) {
  await openDocument(page, name);
  await expect
    .poll(async () => (await page.evaluate(() => window.__leanDemo?.currentDoc()).catch(() => "")) ?? "", {
      timeout: 30_000,
    })
    .toContain(text);
}

function waitForRustWidgetSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/rust-document") &&
      response.ok(),
  );
}

function preparedExampleButton(page: Page, label: string) {
  return page.locator("#examples button").filter({ hasText: label }).first();
}

async function readyExampleLabels(page: Page): Promise<string[]> {
  return page.locator('#examples button[data-ready="true"]').evaluateAll((buttons) =>
    buttons
      .map((button) => button.textContent?.trim() ?? "")
      .filter((label) => label.length > 0),
  );
}

async function notReadyExampleStates(page: Page): Promise<Array<{ disabled: boolean; label: string }>> {
  return page.locator('#examples button[data-ready="false"]').evaluateAll((buttons) =>
    buttons.map((button) => ({
      disabled: button.hasAttribute("disabled"),
      label: button.textContent?.trim() ?? "",
    })),
  );
}

function waitForRustMainSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/rust-main") &&
      response.ok(),
  );
}

function waitForRustMainRegeneration(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/regenerate-rust-main") &&
      response.ok(),
    { timeout: 300_000 },
  );
}

test("demo supports undo and cross-file navigation", async ({ page }) => {
  const insertedSnippet = "#check demo";

  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("Main.rs");

  await openDocument(page, "Main.lean");

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

  await openDocumentContaining(page, "Helper.lean", "def helperValue");
});

test("demo recreates its Lean session after a page reload", async ({ page }) => {
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("Lean server initialized.");

  await page.reload();

  await expect(statusValue(page, "status")).toHaveText("Ready", { timeout: 30_000 });
  await expect(page.locator("#events")).toContainText("Lean server initialized.");
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("demo reconnects Lean without remounting the active editor", async ({ page }) => {
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocumentContaining(page, "Main.lean", "#check Nat.succ");
  await expect(page.locator("#editor [data-lean-semantic-token]").first()).toBeVisible({
    timeout: 15_000,
  });

  expect(
    await page.evaluate(() =>
      window.__leanDemo?.replaceCurrentText("#check Nat.succ", "#check Nat.pred"),
    ),
  ).toBe(true);
  await page.locator("#editor > .cm-editor").evaluate((editor) => {
    (editor as HTMLElement).dataset.reconnectProbe = "preserved";
  });

  await page.evaluate(() => window.__leanDemo?.restartLean());

  await expect(statusValue(page, "status")).toHaveText("Ready", { timeout: 30_000 });
  await expect(page.locator("#events")).toContainText(
    "Lean server reconnected without remounting the editor.",
  );
  await expect(page.locator("#editor > .cm-editor")).toHaveAttribute(
    "data-reconnect-probe",
    "preserved",
  );
  await expect(page.locator("#editor [data-lean-semantic-token]").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("#check Nat.pred");
  expect(await page.evaluate(() => window.__leanDemo?.undo())).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("#check Nat.succ");
});

test("demo opens and syncs the embedded Rust widget", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocument(page, "Main.lean");
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
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocument(page, "Main.lean");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  for (let i = 0; i < 2; i += 1) {
    await clickButtonByText(page, "Show Verso source");
    await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
    await expect.poll(() => hasButtonByText(page, "Render Rust")).toBe(true);
    await expect(page.locator(".cm-content")).toContainText("/-!");
    await expect(page.locator(".cm-content")).toContainText("```rust (name := demoWidget)");
    expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
    await expect(page.locator(".cm-content")).toContainText("a - b");
    expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a - b", "a + b"))).toBe(true);

    await clickButtonByText(page, "Render Rust");
  }

  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("demo inserts a Rust scaffold from the gutter", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocument(page, "Main.lean");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  await clickButtonByText(page, "Add Rust");

  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("```rust (name := «demoWidget-2»)");

  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(2);
});

test("demo opens the Rust driver and refreshes embedded Lean snippets", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("Main.rs");
  await expect(page.locator("#events")).toContainText("rust-analyzer initialized.");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => window.__leanDemo?.currentDoc()))
    .toContain("```lean demo-check");

  await expect(page.locator("#events")).toContainText("Rust driver saved; Lean snippets refreshed.");
});

test("demo sizes short embedded editors to their content", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(2);

  const height = await page
    .locator(".cm-embedded-block-widget .cm-embedded-block-inline .cm-editor")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThan(120);
});

test("demo infoview follows embedded Lean editors", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("Rust driver saved; Lean snippets refreshed.");

  const embeddedLean = page
    .locator(".cm-embedded-block-widget .cm-content")
    .filter({ hasText: "#check helperValue" })
    .first();
  await embeddedLean.click();

  const infoview = page.locator("#lean-infoview");
  await expect(infoview).toContainText("RustSnippets.lean", { timeout: 30_000 });
  await expect(infoview).toContainText("helperValue : Nat", { timeout: 30_000 });
});

test("demo shows hovers in embedded Lean editors", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("Rust driver saved; Lean snippets refreshed.");

  const helperToken = page
    .locator(".cm-embedded-block-widget .cm-content span")
    .filter({ hasText: "helperValue" })
    .first();
  await expect(helperToken).toBeVisible();
  await helperToken.hover();

  const tooltip = page.locator(".cm-tooltip .cm-lsp-hover-tooltip").first();
  await expect(tooltip).toContainText("helperValue", { timeout: 10_000 });
});

test("demo highlights Rust and embedded Lean code", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("Main.rs");
  await expect.poll(() => hasHighlightedToken(page, "#editor > .cm-editor .cm-line span", "pub")).toBe(true);
  await expect
    .poll(() => hasHighlightedToken(page, ".cm-embedded-block-widget .cm-line span", "#check"))
    .toBe(true);
});

test("demo updates Rust and embedded Lean diagnostics after edits", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
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

test("demo keeps versioned Rust diagnostics when a later pull is empty", async ({ page }) => {
  let edited = false;
  let pendingId: string | number | undefined;
  let versionedPush: string | undefined;
  let delivered = false;
  await page.routeWebSocket(/\/rust-main-lsp$/, (route) => {
    const server = route.connectToServer();
    const deliver = () => {
      if (pendingId === undefined || versionedPush === undefined || delivered) return;
      // Replay a real current-version Cargo push before an empty native pull.
      // The two rust-analyzer streams need not contain the same diagnostics.
      route.send(versionedPush);
      route.send(JSON.stringify({
        jsonrpc: "2.0", id: pendingId, result: { kind: "full", items: [] },
      }));
      delivered = true;
    };
    route.onMessage((message) => {
      const payload = JSON.parse(message.toString());
      if (edited && payload.method === "textDocument/diagnostic") {
        pendingId = payload.id;
        deliver();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const payload = JSON.parse(message.toString());
      if (edited && payload.method === "textDocument/publishDiagnostics") {
        if (payload.params.version !== undefined && payload.params.diagnostics.some(
          (diagnostic: { code?: string }) => diagnostic.code === "E0308",
        )) {
          versionedPush = message.toString();
          deliver();
        }
        return;
      }
      route.send(message);
    });
  });
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  edited = true;
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "\"bad\""))).toBe(true);
  await expect.poll(() => delivered).toBe(true);
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).not.toHaveCount(0);
});

test("demo syncs Rust keyboard edits", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#events")).toContainText("rust-analyzer initialized.");
  await expect(page.locator("#events")).toContainText("Rust driver saved; Lean snippets refreshed.");

  await page
    .locator("#editor > .cm-editor .cm-line")
    .filter({ hasText: "a + b" })
    .first()
    .click();
  await page.keyboard.press("End");
  const saved = waitForRustMainSave(page);
  await page.keyboard.type(" +");
  await expect.poll(() => page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("a + b +");
  await saved;

  const restored = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b +", "a + b"))).toBe(true);
  await restored;
  await expect
    .poll(async () => (await page.evaluate(() => window.__leanDemo?.currentDoc()))?.includes("a + b +"))
    .toBe(false);
  await expect(page.locator("#editor > .cm-editor .cm-lintRange-error")).toHaveCount(0);
  await page.waitForTimeout(900);
});

test("demo marks extracted Lean state fresh only when host Rust matches startup extraction", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("Nat.succ", "MissingLeanName"))).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a + b +"))).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Stale");
  await expect(page.locator("#events")).toContainText(
    "Rust changed outside embedded Lean blocks; generated Lean is stale until regeneration.",
  );

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b +", "a + b"))).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");
  await expect(page.locator("#events")).toContainText("Rust host matches the startup extraction again.");

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("MissingLeanName", "Nat.succ"))).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");
});


test("demo keeps saved Rust text and both undo histories across file switches", async ({ page }) => {
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocument(page, "Main.lean");
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("#check Nat.succ", "#check Nat.pred"))).toBe(true);
  await openDocument(page, "Main.rs");
  const saved = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await saved;
  await openDocument(page, "Main.lean");
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("#check Nat.pred");
  expect(await page.evaluate(() => window.__leanDemo?.undo())).toBe(true);
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("#check Nat.succ");
  await openDocument(page, "Main.rs");
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("a - b");
  expect(await readFile(new URL("../../demo/workspace/Main.rs", import.meta.url), "utf8")).toContain("a - b");
  const undone = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.undo())).toBe(true);
  await undone;
});

test("demo recovers Rust after a dropped connection without losing edits", async ({ page }) => {
  let route: import("@playwright/test").WebSocketRoute | undefined;
  let connections = 0;
  await page.routeWebSocket(/\/rust-main-lsp$/, (socket) => {
    route = socket;
    connections++;
    socket.connectToServer();
  });
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  const saved = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await saved;
  await route!.close({ code: 1011, reason: "test interruption" });
  await expect.poll(() => connections).toBe(2);
  await expect(page.locator("#events")).toContainText("Rust server reconnected; editor state preserved.");
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("a - b");
  expect(await page.evaluate(() => window.__leanDemo?.undo())).toBe(true);
});

test("external demo switches prepared examples and preserves embedded Lean diagnostics", async ({ page }) => {
  const targetExample = "namespaces.rs";

  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  const targetButton = await preparedExampleButton(page, targetExample);
  test.skip((await targetButton.count()) === 0, "Prepared example switching requires external demo mode.");
  test.skip(
    (await targetButton.getAttribute("data-ready")) !== "true",
    `${targetExample} must be prebuilt for the external demo check.`,
  );

  await expect(page.locator("#demo-project")).toContainText("google/zerocopy PR 3321");
  await expect(page.locator("#demo-title")).toHaveText("Zerocopy Anneal Embedded Lean Demo");

  await targetButton.click();

  await expect(page.locator("#active-example")).toHaveText(targetExample);
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText(targetExample);
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(1);

  const brokenSave = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("scalar_tac", "MissingLeanName"))).toBe(true);
  await brokenSave;
  await expect(page.locator(".cm-embedded-block-widget .cm-lintRange-error")).not.toHaveCount(0);
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");

  const restoredSave = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("MissingLeanName", "scalar_tac"))).toBe(true);
  await restoredSave;
  await expect(page.locator(".cm-embedded-block-widget .cm-lintRange-error")).toHaveCount(0);
});

test("external demo auto-regenerates stale host Rust edits", async ({ page }) => {
  test.setTimeout(600_000);

  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  const targetButton = await preparedExampleButton(page, "linked_list.rs");
  test.skip((await targetButton.count()) === 0, "Prepared example switching requires external demo mode.");
  test.skip(
    (await targetButton.getAttribute("data-ready")) !== "true",
    "linked_list.rs must be prebuilt for the external auto-regeneration check.",
  );

  await targetButton.click();
  await expect(page.locator("#active-example")).toHaveText("linked_list.rs");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(page.locator("#extraction-state")).toHaveText("Fresh");

  const manualMode = page.locator('#regeneration-mode button[data-mode="manual"]');
  const autoMode = page.locator('#regeneration-mode button[data-mode="auto"]');
  await expect(autoMode).toBeEnabled();
  await autoMode.click();
  await expect(autoMode).toHaveAttribute("data-active", "true");

  const autoRegeneration = waitForRustMainRegeneration(page);
  expect(
    await page.evaluate(() =>
      window.__leanDemo?.replaceCurrentText("fn main() {}", "fn main() { let _ = 0; }")
    ),
  ).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Stale");
  await expect(page.locator("#regenerate-workspace")).toHaveText(/Queued|Regenerating/, { timeout: 5_000 });
  await autoRegeneration;
  await expect(statusValue(page, "status")).toHaveText("Ready", { timeout: 300_000 });
  await expect(page.locator("#extraction-state")).toHaveText("Fresh", { timeout: 300_000 });

  await manualMode.click();
  await expect(manualMode).toHaveAttribute("data-active", "true");
  const restoreRegeneration = waitForRustMainRegeneration(page);
  expect(
    await page.evaluate(() =>
      window.__leanDemo?.replaceCurrentText("fn main() { let _ = 0; }", "fn main() {}")
    ),
  ).toBe(true);
  await expect(page.locator("#extraction-state")).toHaveText("Stale");
  await page.locator("#regenerate-workspace").click();
  await restoreRegeneration;
  await expect(statusValue(page, "status")).toHaveText("Ready", { timeout: 300_000 });
  await expect(page.locator("#extraction-state")).toHaveText("Fresh", { timeout: 300_000 });
});

test("external demo switches through all ready prepared examples", async ({ page }) => {
  await page.goto("/?mode=rust");

  await expect(statusValue(page, "status")).toHaveText("Ready");
  const labels = await readyExampleLabels(page);
  test.skip(labels.length === 0, "Prepared example switching requires external demo mode.");

  await expect(page.locator("#demo-project")).toContainText("google/zerocopy PR 3321");
  expect((await notReadyExampleStates(page)).every((example) => example.disabled)).toBe(true);

  for (const label of labels) {
    await preparedExampleButton(page, label).click();
    await expect(page.locator("#active-example")).toHaveText(label);
    await expect(statusValue(page, "status")).toHaveText("Ready");
    await expect(statusValue(page, "document")).toContainText(label);
    await expect(page.locator("#extraction-state")).toHaveText("Fresh");
    await expect(page.locator(".cm-embedded-block-widget")).not.toHaveCount(0);
  }
});

test("static Aeneas mock-up pairs a Rust docstring with checked Lean without regeneration", async ({ page }) => {
  let regenerationRequests = 0;
  page.on("request", request => {
    if (request.url().endsWith("/regenerate-rust-main")) regenerationRequests++;
  });
  await page.goto("/");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("AeneasDemo.lean");
  await expect(page.locator("#extraction-state")).toHaveText("Static mock-up");
  await expect(page.locator("#regenerate-workspace")).toBeDisabled();
  const content = page.locator("#editor > .cm-editor .cm-content");
  await expect(content).toContainText("pub fn bump(x: &mut u32)");
  await expect(content).toContainText("Static mock-up:");
  const before = (await page.evaluate(() => window.__leanDemo?.currentDoc()))!;
  expect(before).toContain("-/\ndef bump (x : U32) : Result U32");
  const tooltip = page.locator(".cm-tooltip .cm-lsp-hover-tooltip");
  await hoverSourceText(page, "pub fn bump(", "bump");
  await expect(tooltip).toContainText("fn bump");
  await expect(tooltip).toContainText("mut u32");
  await page.mouse.move(10, 10);
  await hoverSourceText(page, "#check bump", "bump");
  await expect(tooltip).toContainText("AeneasDemo.bump");
  await page.mouse.move(10, 10);
  await page.locator("#lean-infoview").getByText("All Messages", { exact: false }).first().click();
  await expect(page.locator("#lean-infoview")).toContainText("Except.ok 42");
  await expect(page.locator("#lean-infoview")).toContainText("integerOverflow");
  await expect(content.locator("..").locator(".cm-lintRange-error")).toHaveCount(0);

  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("*x += 1;", "*x += 2;"))).toBe(true);
  const after = (await page.evaluate(() => window.__leanDemo?.currentDoc()))!;
  expect(after.slice(after.indexOf("\ndef bump"))).toBe(before.slice(before.indexOf("\ndef bump")));
  await expect(page.locator("#extraction-state")).toHaveText("Static mock-up");

  await clickButtonByText(page, "Render Rust");
  await page.getByRole("button", { name: "Edit Rust", exact: true }).click();
  await page.locator(".cm-embedded-block-inline .cm-content").click();
  const saved = page.waitForResponse(response => response.url().endsWith("/rust-document") &&
    response.ok() && response.request().postDataJSON()?.code?.includes("*x += 3;"));
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("3");
  await saved;
  await clickButtonByText(page, "Show Verso source");
  const inlineEdited = (await page.evaluate(() => window.__leanDemo?.currentDoc()))!;
  expect(inlineEdited).toContain("*x += 3;");
  expect(inlineEdited.slice(inlineEdited.indexOf("\ndef bump"))).toBe(before.slice(before.indexOf("\ndef bump")));

  // Lean remains live and checked even though the source/translation pairing is static.
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("checkedAdd x 1", "checkedAdd x 2"))).toBe(true);
  await content.click();
  await page.keyboard.press("Control+End");
  await expect(content.locator("..").locator(".cm-lintRange-error")).not.toHaveCount(0);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("checkedAdd x 2", "checkedAdd x 1"))).toBe(true);
  await expect(content.locator("..").locator(".cm-lintRange-error")).toHaveCount(0);
  expect(regenerationRequests).toBe(0);
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("Lean basic example shows editable raw Verso source with current Rust and Lean hovers", async ({ page }) => {
  const methods: string[] = [];
  await page.routeWebSocket(/\/rust-lsp\?/, route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      const message = JSON.parse(raw.toString());
      if (message.method) methods.push(message.method);
      server.send(raw);
    });
  });
  await page.goto("/?example=basic");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("Main.lean");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
  const content = page.locator("#editor > .cm-editor .cm-content");
  await expect(content).toContainText("/-!");
  await expect(content).toContainText("```rust (name := demoWidget)");
  const tooltip = page.locator(".cm-tooltip .cm-lsp-hover-tooltip");
  await hoverSourceText(page, "fn add(", "add");
  await expect(tooltip).toContainText("fn add");
  await expect(tooltip).toContainText("i32");
  expect(methods).toContain("textDocument/hover");
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText(
    "fn add(a: i32, b: i32) -> i32", "fn add(a: i64, b: i64) -> i64",
  ))).toBe(true);
  await page.mouse.move(10, 10);
  await hoverSourceText(page, "fn add(", "add");
  await expect(tooltip).toContainText("i64");
  expect(methods).toContain("textDocument/didChange");
  await page.mouse.move(10, 10);
  await hoverSourceText(page, "#check Nat.succ", "succ");
  await expect(tooltip).toContainText("Nat.succ");
  await clickButtonByText(page, "Render Rust");
  await expect(page.getByLabel("Rust code preview")).toContainText("i64");
  await page.getByRole("button", { name: "Edit Rust", exact: true }).click();
  await expect(page.locator(".cm-embedded-block-inline .cm-content")).toContainText("i64");
  await clickButtonByText(page, "Show Verso source");
  await expect(page.locator(".cm-embedded-block-widget")).toHaveCount(0);
  await expect(content).toContainText("```rust (name := demoWidget)");
  await expect(content).toContainText("i64");
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("Edits stay in this Lean document.");
  await page.mouse.move(10, 10);
  await hoverSourceText(page, "fn add(", "add");
  await expect(tooltip).toContainText("i64");
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("rendered mode keeps Rosetta preview and all inline Rust editor features", async ({ page }) => {
  const methods = new Set<string>();
  await page.routeWebSocket(/\/rust-lsp\?/, route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      const message = JSON.parse(raw.toString());
      if (message.method) methods.add(message.method);
      server.send(raw);
    });
  });
  await page.goto("/?example=basic&view=rendered");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await expect(statusValue(page, "document")).toContainText("Main.lean");
  const preview = page.getByLabel("Rust code preview");
  await expect(preview).toBeVisible();
  const token = preview.locator('[data-rosetta-token="function"]').filter({ hasText: /^add$/ }).first();
  await expect(token).toBeVisible();
  await token.hover();
  await expect(token).toHaveAttribute("title", /add/);
  await page.getByRole("button", { name: "Edit Rust", exact: true }).click();
  const content = page.locator(".cm-embedded-block-inline .cm-content");
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F2");
  const rename = page.locator(".cm-lsp-rename-panel input");
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue("add");
  await rename.fill("sum");
  await rename.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("fn sum");
  await expect(content).toContainText("sum(20, 22)");
  await content.click();
  await page.keyboard.press("Control+Home");
  const lines = await content.locator(".cm-line").allTextContents();
  for (let i = 0; i < lines.findIndex(line => line.includes("println!")); i++) await page.keyboard.press("ArrowDown");
  const call = await content.locator(".cm-line").filter({ hasText: "println!" }).innerText();
  for (let i = 0; i < call.indexOf("sum(") + 1; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F12");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent)).toContain("fn sum");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nfn completion() { su }");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("sum");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("fn completion() { su }", "fn completion() { let _ = sum(1, 2); }"))).toBe(true);
  await page.keyboard.press("Shift+Alt+f");
  await expect.poll(() => page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("fn completion() {\n    let _ = sum(1, 2);\n}");
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", '"bad"'))).toBe(true);
  await expect(page.locator(".cm-embedded-block-inline .cm-lintRange-error")).not.toHaveCount(0);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText('"bad"', "a + b"))).toBe(true);
  await expect(page.locator(".cm-embedded-block-inline .cm-lintRange-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Preview Rust", exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("fn sum");
  expect(await page.evaluate(() => window.__leanDemo?.currentDoc())).toContain("Edits stay in this Lean document.");
  // Diagnostics above may arrive as a current-version push before a pull is needed.
  for (const method of ["textDocument/hover", "textDocument/completion", "textDocument/definition", "textDocument/rename", "textDocument/formatting"]) {
    expect(methods.has(method), method).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});

test("inline Rust retries a failed Rosetta reconnect and preserves preview toggles", async ({ page }) => {
  let socket: import("@playwright/test").WebSocketRoute | undefined;
  let connections = 0;
  await page.routeWebSocket(/\/rust-lsp\?/, route => {
    socket = route;
    connections++;
    if (connections === 2) { void route.close({ code: 1011, reason: "temporary outage" }); return; }
    route.connectToServer();
  });
  await page.goto("/?example=basic&view=rendered");
  await expect(page.getByLabel("Rust code preview").locator("[data-rosetta-token]").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit Rust", exact: true }).click();
  const content = page.locator(".cm-embedded-block-inline .cm-content");
  const saved = waitForRustWidgetSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a + b", "a - b"))).toBe(true);
  await saved;
  await content.evaluate(element => { element.dataset.reconnectProbe = "preserved"; });
  await socket!.close({ code: 1011, reason: "test interruption" });
  await expect.poll(() => connections).toBe(3);
  await expect(page.locator(".cm-embedded-block-inline-status")).toBeHidden();
  await expect(content).toHaveAttribute("data-reconnect-probe", "preserved");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Preview Rust", exact: true }).click();
    await expect(page.getByLabel("Rust code preview")).toContainText("a - b");
    await page.getByRole("button", { name: "Edit Rust", exact: true }).click();
  }
  const nextSave = waitForRustWidgetSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("a - b", "a + b"))).toBe(true);
  await nextSave;
  await expect(content).toContainText("a + b");
});

test("regenerated Lean updates a previously opened hidden editor", async ({ page }) => {
  await page.goto("/?mode=rust");
  await expect(statusValue(page, "status")).toHaveText("Ready");
  await openDocumentContaining(page, "RustSnippets.lean", "#check Nat.succ");
  await openDocument(page, "Main.rs");
  const saved = waitForRustMainSave(page);
  expect(await page.evaluate(() => window.__leanDemo?.replaceCurrentText("Nat.succ", "Nat.pred"))).toBe(true);
  await saved;
  await openDocumentContaining(page, "RustSnippets.lean", "#check Nat.pred");
  expect(await page.evaluate(() => (window as any).__consumeConsoleErrors())).toEqual([]);
});
