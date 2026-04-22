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

async function startDemo() {
  runtime?.dispose();
  runtime = await bootDemoRuntime({
    editorTheme: demoTheme(),
    embeddedAdapters: createDemoEmbeddedAdapters(sessionApi),
    sessionApi,
    ui: demoUi,
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtime?.dispose();
    runtime = null;
  });
}

void startDemo().catch((error) => {
  runtime?.dispose();
  runtime = null;
  demoUi.setStatus("Boot failed");
  demoUi.logEvent(error instanceof Error ? error.message : String(error));
  throw error;
});
