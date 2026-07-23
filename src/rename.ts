import { LSPPlugin } from "@codemirror/lsp-client";
import {
  getDialog,
  showDialog,
  type Command,
  type KeyBinding,
} from "@codemirror/view";
import type {
  RenameParams,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

import { applyLeanWorkspaceEdit } from "./workspaceEdit.js";

async function requestRename(
  view: Parameters<Command>[0],
  newName: string,
): Promise<void> {
  const plugin = LSPPlugin.get(view);
  const word = view.state.wordAt(view.state.selection.main.head);
  if (!plugin || !word) {
    return;
  }

  plugin.client.sync();
  await plugin.client.withMapping(async (mapping) => {
    const response = await plugin.client.request<RenameParams, WorkspaceEdit | null>(
      "textDocument/rename",
      {
        newName,
        position: plugin.toPosition(word.from),
        textDocument: { uri: plugin.uri },
      },
    );
    if (!response) {
      return;
    }
    const result = await applyLeanWorkspaceEdit(plugin.client, response, {
      mapping,
      userEvent: "rename",
    });
    if (!result.applied) {
      throw new Error(result.failureReason ?? "The workspace edit was rejected.");
    }
  });
}

/**
 * Prompt for and apply a Lean rename, including edits to asynchronously loaded
 * workspace documents.
 */
export const leanRenameSymbol: Command = (view) => {
  const wordRange = view.state.wordAt(view.state.selection.main.head);
  const plugin = LSPPlugin.get(view);
  if (
    !wordRange ||
    !plugin ||
    plugin.client.serverCapabilities?.renameProvider === false
  ) {
    return false;
  }

  const word = view.state.sliceDoc(wordRange.from, wordRange.to);
  const openPanel = getDialog(view, "cm-lean-rename-panel");
  if (openPanel) {
    const input = openPanel.dom.querySelector<HTMLInputElement>("[name=name]");
    if (input) {
      input.value = word;
      input.select();
    }
    return true;
  }

  const { close, result } = showDialog(view, {
    label: view.state.phrase("New name"),
    input: { name: "name", value: word },
    focus: true,
    submitLabel: view.state.phrase("rename"),
    class: "cm-lean-rename-panel",
  });
  void result.then((form) => {
    view.dispatch({ effects: close });
    if (!form) {
      return;
    }
    const input = form.elements.namedItem("name");
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    void requestRename(view, input.value).catch((error: unknown) => {
      plugin.reportError("Rename request failed", error);
    });
  });
  return true;
};

/** Binds F2 to the cross-file-aware Lean rename command. */
export const leanRenameKeymap: readonly KeyBinding[] = [
  { key: "F2", run: leanRenameSymbol, preventDefault: true },
];
