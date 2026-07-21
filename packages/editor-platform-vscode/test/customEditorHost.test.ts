import { describe, expect, test } from "vitest";

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
