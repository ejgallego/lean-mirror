import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mountLeanWorkspace,
  type MountLeanWorkspaceOptions,
  type WorkspaceDocumentState,
} from "../examples/workspace/publicLeanWorkspace.js";

vi.mock("@leanprover/infoview", () => {
  const complete = async (): Promise<void> => {};
  return {
    defaultInfoviewConfig: {},
    mountInfoview: undefined,
    renderInfoview(_editorApi: unknown, element: HTMLElement) {
      element.append(Object.assign(document.createElement("div"), { className: "fake-infoview" }));
      return {
        changedCursorLocation: complete, changedInfoviewConfig: complete, initialize: complete,
        serverRestarted: complete, serverStopped: complete,
        gotServerNotification: complete, sentClientNotification: complete,
      };
    },
  };
});

/** A WebSocket that never opens until the test closes it. */
class PendingWebSocket extends EventTarget {
  static readonly instances: PendingWebSocket[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    PendingWebSocket.instances.push(this);
  }
  send(): void {
    throw new Error("A pending socket must not send.");
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const MAIN = "file:///workspace/Main.lean";
const HELPER = "file:///workspace/Helper.lean";

function mountOptions(overrides: Partial<MountLeanWorkspaceOptions> = {}) {
  const editorContainer = document.body.appendChild(document.createElement("div"));
  const infoviewContainer = document.body.appendChild(document.createElement("div"));
  const states: WorkspaceDocumentState[] = [];
  const options: MountLeanWorkspaceOptions = {
    documents: [
      { uri: MAIN, text: "import Helper\r\nb\nc\r\n", revision: "r1" },
      { uri: HELPER, text: "def helper := 1\n", revision: "r2" },
    ],
    editorContainer,
    infoviewContainer,
    rootUri: "file:///workspace",
    websocketUrl: "ws://127.0.0.1:1/lsp",
    saveDocument: vi.fn(async (document) => document),
    onDocumentState: (state) => states.push(state),
    ...overrides,
  };
  return { options, editorContainer, infoviewContainer, states };
}

beforeEach(() => {
  PendingWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", PendingWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("workspace example host lifecycle", () => {
  it("mounts editors before Lean connects and tracks dirty state by content", () => {
    const { options, states } = mountOptions();
    const workspace = mountLeanWorkspace(options);

    expect(workspace.currentUri).toBe(MAIN);
    expect(workspace.session.client).toBeNull();
    const view = workspace.currentView;
    view.dispatch({ changes: { from: 0, insert: "-- " } });
    expect(states.at(-1)).toMatchObject({ uri: MAIN, dirty: true });
    // Restoring the content of a mixed-ending file leaves it clean.
    view.dispatch({ changes: { from: 0, to: 3 } });
    expect(states.at(-1)).toMatchObject({ uri: MAIN, dirty: false });

    workspace.dispose();
  });

  it.each(["dispose", "signal"] as const)("cancels startup through %s before Lean connects", async (via) => {
    const controller = new AbortController();
    const { options, editorContainer, infoviewContainer } = mountOptions({ signal: controller.signal });
    const workspace = mountLeanWorkspace(options);
    const socket = PendingWebSocket.instances[0];
    expect(socket?.readyState).toBe(0);
    expect(editorContainer.querySelector(".cm-editor")).not.toBeNull();
    expect(infoviewContainer.querySelector(".fake-infoview")).not.toBeNull();

    if (via === "dispose") workspace.dispose();
    else controller.abort();

    await expect(workspace.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(socket?.readyState).toBe(3);
    expect(PendingWebSocket.instances).toHaveLength(1);
    expect(workspace.session.state.phase).toBe("disposed");
    expect(editorContainer.querySelector(".cm-editor")).toBeNull();
    expect(infoviewContainer.querySelector(".fake-infoview")).toBeNull();
    await expect(workspace.saveAll()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to mount with an already aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const { options, editorContainer } = mountOptions({ signal: controller.signal });
    expect(() => mountLeanWorkspace(options)).toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(PendingWebSocket.instances).toHaveLength(0);
    expect(editorContainer.childElementCount).toBe(0);
  });
});
