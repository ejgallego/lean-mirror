import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";

import {
  EditorPlatformStore,
  platformMessage,
  type DisposableLike,
  type EditorToHostMessage,
  type HostToEditorMessage
} from "@leanprover/editor-platform";
import {
  attachEditorPlatformHostToPanel,
  createEditorPlatformCustomEditorHost,
  documentOpenedMessage,
  vscodeUriToString,
  type VsCodeCustomDocumentLike,
  type VsCodeWebviewLike,
  type VsCodeWebviewPanelLike
} from "../src/index.js";

class FakeWebview implements VsCodeWebviewLike {
  readonly posted: HostToEditorMessage[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();

  postMessage(message: HostToEditorMessage): boolean {
    this.posted.push(message);
    return true;
  }

  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  receive(message: EditorToHostMessage | unknown): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

class FakePanel implements VsCodeWebviewPanelLike {
  readonly webview = new FakeWebview();
  private readonly disposeListeners = new Set<() => void>();

  onDidDispose(listener: () => void): DisposableLike {
    this.disposeListeners.add(listener);
    return {
      dispose: () => {
        this.disposeListeners.delete(listener);
      }
    };
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) {
      listener();
    }
  }
}

describe("custom editor host", () => {
  test("publishes snapshots and handles editor commands", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const opened: string[] = [];
    const restarted: string[] = [];
    const active: string[] = [];

    const host = createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        openDocument: ({ uri }) => {
          opened.push(uri);
        },
        restartService: ({ serviceId }) => {
          restarted.push(serviceId);
        },
        setActiveDocument: ({ uri }) => {
          active.push(uri);
        }
      }
    });

    expect(webview.posted.map((message) => message.type)).toEqual(["platform-snapshot"]);

    webview.receive(platformMessage("open-document", { uri: "file:///Main.lean" }));
    webview.receive(platformMessage("set-active-document", { uri: "file:///Main.lean", languageId: "lean" }));
    webview.receive(platformMessage("restart-service", { serviceId: "lean" }));

    await waitFor(() => active.length === 1);

    expect(opened).toEqual(["file:///Main.lean"]);
    expect(active).toEqual(["file:///Main.lean"]);
    expect(restarted).toEqual(["lean"]);
    expect(store.snapshot.activeDocumentUri).toBe("file:///Main.lean");

    host.dispose();
    store.setActiveDocument("file:///AfterDispose.lean");
    expect(webview.posted).toHaveLength(2);
  });

  test("reports invalid messages", () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const invalid: unknown[] = [];

    createEditorPlatformCustomEditorHost({
      store,
      webview,
      onInvalidMessage: (message) => {
        invalid.push(message);
      }
    });

    webview.receive({ protocol: "editor-platform", version: 1, type: "platform-snapshot", payload: {} });

    expect(invalid).toHaveLength(1);
  });

  test("acknowledges correlated editor commands", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const host = createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        openDocument: () => undefined
      }
    });

    webview.receive(platformMessage("open-document", {
      requestId: "open-1",
      uri: "file:///Main.lean"
    }));
    await waitFor(() => webview.posted.some((message) => message.type === "command-result"));

    expect(webview.posted.at(-1)).toEqual(platformMessage("command-result", {
      command: "open-document",
      handled: true,
      ok: true,
      requestId: "open-1"
    }));
    host.dispose();
  });

  test("reports correlated command failures to the editor", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const errors: unknown[] = [];
    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        restartService() {
          throw new Error("restart refused");
        }
      },
      onHandlerError(error) {
        errors.push(error);
      }
    });

    webview.receive(platformMessage("restart-service", {
      requestId: 9,
      serviceId: "lean"
    }));
    await waitFor(() => webview.posted.some((message) => message.type === "command-result"));

    expect(webview.posted.at(-1)).toEqual(platformMessage("command-result", {
      command: "restart-service",
      message: "restart refused",
      ok: false,
      requestId: 9
    }));
    expect(errors).toHaveLength(1);
  });

  test("does not acknowledge an in-flight command after disposal", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        async openDocument() {
          await canFinish;
        }
      }
    });

    webview.receive(platformMessage("open-document", {
      requestId: "open-after-dispose",
      uri: "file:///Main.lean"
    }));
    host.dispose();
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(webview.posted.some((message) => message.type === "command-result")).toBe(false);
  });

  test("acknowledges stale document versions as unhandled", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        documentChanged: () => undefined
      }
    });

    webview.receive(platformMessage("document-changed", {
      requestId: "change-2",
      text: "new",
      uri: "file:///Main.lean",
      version: 2
    }));
    await waitFor(() => webview.posted.some(
      (message) => message.type === "command-result" && message.payload.requestId === "change-2"
    ));
    webview.receive(platformMessage("document-changed", {
      requestId: "change-1",
      text: "old",
      uri: "file:///Main.lean",
      version: 1
    }));
    await waitFor(() => webview.posted.some(
      (message) => message.type === "command-result" && message.payload.requestId === "change-1"
    ));

    expect(webview.posted.at(-1)).toEqual(platformMessage("command-result", {
      command: "document-changed",
      handled: false,
      ok: true,
      requestId: "change-1"
    }));
  });

  test("serializes document changes and ignores stale versions", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const handled: number[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        async documentChanged({ version }) {
          handled.push(version ?? -1);
          if (version === 1) {
            await firstCanFinish;
          }
        }
      }
    });

    webview.receive(
      platformMessage("document-changed", { uri: "file:///Main.lean", text: "one", version: 1 })
    );
    webview.receive(
      platformMessage("document-changed", { uri: "file:///Main.lean", text: "two", version: 2 })
    );
    expect(handled).toEqual([1]);

    releaseFirst();
    await waitFor(() => handled.length === 2);
    expect(handled).toEqual([1, 2]);

    webview.receive(
      platformMessage("document-changed", { uri: "file:///Main.lean", text: "stale", version: 1 })
    );
    await Promise.resolve();
    expect(handled).toEqual([1, 2]);
  });

  test("accepts restarted document versions after the webview reloads", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const handled: string[] = [];
    let releaseOld!: () => void;
    const oldCanFinish = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });

    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        async documentChanged({ text, version }) {
          handled.push(`${version}:${text}`);
          if (text === "old-3") {
            await oldCanFinish;
          }
        }
      }
    });
    const uri = "file:///Main.lean";

    webview.receive(platformMessage("document-changed", { uri, text: "old-2", version: 2 }));
    webview.receive(platformMessage("document-changed", { uri, text: "old-3", version: 3 }));
    await waitFor(() => handled.length === 2);
    // Reload while the old webview's last change is still being handled.
    webview.receive(platformMessage("ready", {}));
    releaseOld();
    webview.receive(platformMessage("document-changed", { uri, text: "new-1", version: 1 }));
    webview.receive(platformMessage("document-changed", { uri, text: "new-2", version: 2 }));
    await waitFor(() => handled.length === 4);
    webview.receive(platformMessage("document-changed", { uri, text: "stale", version: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handled).toEqual(["2:old-2", "3:old-3", "1:new-1", "2:new-2"]);
  });

  test("does not reply to the reloaded webview with an earlier webview's result", async () => {
    const webview = new FakeWebview();
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    const completed: string[] = [];
    createEditorPlatformCustomEditorHost({
      store: new EditorPlatformStore(),
      webview,
      publishSnapshots: false,
      handlers: {
        async documentChanged({ text }) {
          await (text === "old" ? oldGate : newGate);
          completed.push(text);
        }
      }
    });
    const change = (text: string, version: number) => webview.receive(platformMessage("document-changed", {
      uri: "file:///Main.lean", text, version, requestId: "change:1"
    }));
    const results = () => webview.posted.filter((message) => message.type === "command-result");

    change("old", 99);
    webview.receive(platformMessage("ready", {}));
    change("new", 1);
    releaseOld();
    await waitFor(() => completed.includes("old"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Both views may use request ID change:1; only the new handler may answer it.
    expect(results()).toEqual([]);

    releaseNew();
    await waitFor(() => results().length === 1);
    expect(completed).toEqual(["old", "new"]);
    expect(results()).toEqual([platformMessage("command-result", {
      command: "document-changed", handled: true, ok: true, requestId: "change:1"
    })]);
  });

  test("drops an earlier webview's queued commands after ready", async () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activated: string[] = [];
    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        documentChanged: () => gate,
        setActiveDocument({ uri }) { activated.push(uri); }
      }
    });

    webview.receive(platformMessage("document-changed", { uri: "file:///Old.lean", text: "old", version: 1 }));
    // Queued behind the pending change for the same URI.
    webview.receive(platformMessage("set-active-document", { uri: "file:///Old.lean" }));
    webview.receive(platformMessage("ready", {}));
    webview.receive(platformMessage("set-active-document", { uri: "file:///New.lean" }));
    await waitFor(() => activated.length === 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.snapshot.activeDocumentUri).toBe("file:///New.lean");
    expect(activated).toEqual(["file:///New.lean"]);
  });

  test("rejects malformed editor commands before invoking handlers", () => {
    const store = new EditorPlatformStore();
    const webview = new FakeWebview();
    const invalid: unknown[] = [];
    let changes = 0;

    createEditorPlatformCustomEditorHost({
      store,
      webview,
      handlers: {
        documentChanged() {
          changes += 1;
        }
      },
      onInvalidMessage(message) {
        invalid.push(message);
      }
    });

    webview.receive({
      protocol: "editor-platform",
      version: 1,
      type: "document-changed",
      payload: {}
    });

    expect(changes).toBe(0);
    expect(invalid).toHaveLength(1);
  });

  test("attaches host disposal to a panel", () => {
    const store = new EditorPlatformStore();
    const panel = new FakePanel();

    attachEditorPlatformHostToPanel(panel, { store });
    expect(panel.webview.posted).toHaveLength(1);

    panel.dispose();
    store.setActiveDocument("file:///AfterDispose.lean");

    expect(panel.webview.posted).toHaveLength(1);
  });

  test("uses encoded transport URIs for percent escapes and special filename characters", () => {
    const identities = new Set<string>();
    for (const name of ["Main%23draft.lean", "Main#draft.lean", "Main%20draft.lean", "Main draft.lean", "𝒜.lean"]) {
      const path = "/workspace/" + name;
      const toString = vi.fn((skipEncoding?: boolean) => skipEncoding
        ? "file://" + path.replaceAll("#", "%23").replaceAll("?", "%3F")
        : pathToFileURL(path).href);
      const uri = { toString };
      const serialized = vscodeUriToString(uri);
      expect(fileURLToPath(serialized)).toBe(path);
      expect(toString).toHaveBeenCalledWith();
      identities.add(serialized);
    }
    expect(identities.size).toBe(5);
  });

  test("creates document-opened messages from VS Code-shaped documents", () => {
    const document: VsCodeCustomDocumentLike = {
      uri: {
        scheme: "file",
        fsPath: "/workspace/Main.lean",
        toString: () => "file:///workspace/Main.lean"
      }
    };

    const message = documentOpenedMessage(document, {
      languageId: "lean",
      version: 7,
      text: "def x := 1"
    });

    expect(vscodeUriToString(document.uri)).toBe("file:///workspace/Main.lean");
    expect(message).toEqual({
      protocol: "editor-platform",
      version: 1,
      type: "document-opened",
      payload: {
        document: {
          uri: "file:///workspace/Main.lean",
          languageId: "lean",
          version: 7,
          openState: "open",
          syncState: "clean"
        },
        text: "def x := 1"
      }
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}
