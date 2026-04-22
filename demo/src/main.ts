import {
  createDemoEmbeddedAdapters,
} from "./embeddedAdapters.js";
import { bootDemoRuntime, type DemoRuntime } from "./demoRuntime.js";
import { createDemoSessionApi } from "./demoSession.js";
import { demoTheme, queryDemoUi } from "./demoUi.js";

import "./style.css";

const ui = queryDemoUi(document);

if (!ui) {
  throw new Error("Demo DOM is incomplete.");
}

const demoUi = ui;

let apiBase = import.meta.env.VITE_LEAN_DEMO_API ?? "http://127.0.0.1:7357";
const sessionApi = createDemoSessionApi(apiBase);
let runtime: DemoRuntime | null = null;
let runToken = 0;
let stopped = false;
let lastReconnectMessage: string | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientReasonMessage(reason: unknown): string | null {
  if (reason && typeof reason === "object") {
    const maybeError = reason as { code?: unknown; message?: unknown };
    if (maybeError.code === -32801 && typeof maybeError.message === "string") {
      return maybeError.message;
    }
    if (typeof maybeError.message === "string") {
      return maybeError.message;
    }
  }
  if (typeof reason === "string") {
    return reason;
  }
  return null;
}

function isTransientReconnectReason(reason: unknown): boolean {
  const message = transientReasonMessage(reason);
  if (!message) {
    return false;
  }
  return (
    message.includes("Failed to fetch") ||
    message.includes("WebSocket connection failed") ||
    message.includes("file worker") ||
    message.includes("content modified")
  );
}

async function startDemoLoop() {
  const token = ++runToken;
  let attempt = 0;

  while (!stopped && token === runToken) {
    runtime?.dispose();
    runtime = null;
    if (attempt > 0) {
      demoUi.setStatus("Reconnecting");
    }
    try {
      runtime = await bootDemoRuntime({
        editorTheme: demoTheme(),
        embeddedAdapters: createDemoEmbeddedAdapters(sessionApi),
        sessionApi,
        ui: demoUi,
      });
      lastReconnectMessage = null;
      return;
    } catch (error) {
      if (stopped || token !== runToken) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      demoUi.setStatus("Reconnecting");
      if (message !== lastReconnectMessage) {
        demoUi.logEvent(`Reconnect pending: ${message}`);
        lastReconnectMessage = message;
      }
      attempt += 1;
      await delay(Math.min(1500, 250 * attempt));
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopped = true;
    runToken += 1;
    runtime?.dispose();
    runtime = null;
  });
}

window.addEventListener("unhandledrejection", (event) => {
  if (!isTransientReconnectReason(event.reason)) {
    return;
  }
  event.preventDefault();
});

void startDemoLoop();
