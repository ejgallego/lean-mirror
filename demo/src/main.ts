import {
  demoEmbeddedAdapters,
} from "./embeddedAdapters.js";
import { bootDemoRuntime } from "./demoRuntime.js";
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
void bootDemoRuntime({
  editorTheme: demoTheme(),
  embeddedAdapters: demoEmbeddedAdapters,
  sessionApi,
  ui: demoUi,
}).catch((error) => {
  demoUi.setStatus("Boot failed");
  demoUi.logEvent(error instanceof Error ? error.message : String(error));
  throw error;
});
