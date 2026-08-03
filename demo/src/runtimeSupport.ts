import type * as lsp from "vscode-languageserver-protocol";
import type { EditorServiceDescriptor } from "@leanprover/editor-platform";
import type { Transport } from "codemirror-lean4-lsp";

import type { WorkDoneProgressState } from "../../src/progress.js";
import type { RegenerationMode } from "./demoUi.js";

const regenerationModeStorageKey = "lean-demo-regeneration-mode";

export const leanService: EditorServiceDescriptor = {
  id: "lean-lsp",
  kind: "lean-lsp",
  label: "Lean",
};

export const rustService: EditorServiceDescriptor = {
  id: "rust-lsp",
  kind: "rust-lsp",
  label: "Rust",
};

export function loadRegenerationMode(): RegenerationMode {
  try {
    return window.localStorage.getItem(regenerationModeStorageKey) === "auto" ? "auto" : "manual";
  } catch {
    return "manual";
  }
}

export function saveRegenerationMode(mode: RegenerationMode): void {
  try {
    window.localStorage.setItem(regenerationModeStorageKey, mode);
  } catch {
    // Ignore storage failures; mode still applies to the current runtime.
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function observeInitializeResult(
  transport: Transport,
  onInitializeResult: (result: lsp.InitializeResult) => void,
): Transport {
  const handlers = new Map<(message: string) => void, (message: string) => void>();
  return {
    send(message) {
      transport.send(message);
    },
    subscribe(handler) {
      const wrapped = (message: string) => {
        try {
          const payload = JSON.parse(message) as Partial<lsp.ResponseMessage>;
          if (
            payload &&
            "result" in payload &&
            payload.result &&
            typeof payload.result === "object" &&
            "capabilities" in payload.result
          ) {
            onInitializeResult(payload.result as lsp.InitializeResult);
          }
        } catch {
          // The underlying LSP client will report malformed messages.
        }
        handler(message);
      };
      handlers.set(handler, wrapped);
      transport.subscribe(wrapped);
    },
    unsubscribe(handler) {
      const wrapped = handlers.get(handler);
      if (!wrapped) {
        return;
      }
      handlers.delete(handler);
      transport.unsubscribe(wrapped);
    },
  };
}

export function workDoneProgressMessage(state: WorkDoneProgressState): string {
  const percentage = typeof state.percentage === "number" ? ` ${state.percentage}%` : "";
  return state.message ? `${state.title}${percentage}: ${state.message}` : `${state.title}${percentage}`;
}
