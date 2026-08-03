import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { readDemoConfig } from "./demo-config.mjs";
import { withPlaywrightEnv } from "./playwright-env.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const wrapperArgs = process.argv.slice(2);
const env = withPlaywrightEnv({
  ...process.env,
  DEMO_BACKEND_HOST: process.env.DEMO_BACKEND_HOST ?? "127.0.0.1",
  DEMO_BACKEND_PORT: process.env.DEMO_BACKEND_PORT ?? "7360",
  DEMO_FRONTEND_HOST: process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1",
  DEMO_FRONTEND_PORT: process.env.DEMO_FRONTEND_PORT ?? "4174",
  PLAYWRIGHT_REUSE_EXISTING_SERVER: "1",
});
const demo = readDemoConfig(env);
const warmExamples =
  env.LEAN_DEMO_WARM_EXAMPLES !== "0" && !wrapperArgs.includes("--no-warm");
const readyTimeoutMs = Number.parseInt(
  env.DEMO_EXTERNAL_E2E_READY_TIMEOUT_MS ?? "1800000",
  10,
);

if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
  throw new Error("DEMO_EXTERNAL_E2E_READY_TIMEOUT_MS must be a positive integer.");
}

let demoChild = null;
let playwrightChild = null;
let forwardedSignal = null;

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGINT");
  const stopped = await Promise.race([
    childExit(child).then(() => true),
    delay(5_000, false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const terminated = await Promise.race([
      childExit(child).then(() => true),
      delay(3_000, false),
    ]);
    if (!terminated && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

function forwardSignal(signal) {
  forwardedSignal = signal;
  playwrightChild?.kill(signal);
  demoChild?.kill(signal);
}

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

async function fetchSession() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${demo.backendUrl}/session`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`session request returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForExternalDemo(childExited) {
  const deadline = Date.now() + readyTimeoutMs;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const exited = await Promise.race([childExited, delay(0, null)]);
    if (exited) {
      throw new Error(
        `Zerocopy demo exited before becoming ready (${exited.code ?? exited.signal ?? "unknown"}).`,
      );
    }

    let session = null;
    try {
      session = await fetchSession();
    } catch {
      // The wrapper may still be cloning, generating, or starting its backend.
    }
    if (session) {
      const examples = Array.isArray(session.availableExamples) ? session.availableExamples : [];
      const readyCount = examples.filter((example) => example?.ready === true).length;
      const phase = session.preparationStatus?.phase ?? "unknown";
      const progress = warmExamples
        ? `${phase}; ${readyCount}/${examples.length} prepared examples ready`
        : `${phase}; active example ready`;
      if (progress !== lastProgress) {
        console.log(`[test:e2e:zerocopy-anneal] ${progress}`);
        lastProgress = progress;
      }
      if (phase === "failed") {
        throw new Error(session.preparationStatus?.message ?? "External demo preparation failed.");
      }
      const allExamplesReady = examples.length > 0 && readyCount === examples.length;
      if (phase === "ready" && (!warmExamples || allExamplesReady)) {
        return;
      }
    }
    await delay(500);
  }
  const expectation = warmExamples ? "all prepared examples" : "the active example";
  throw new Error(`Timed out waiting for ${expectation} at ${demo.backendUrl}.`);
}

async function main() {
  demoChild = spawn(
    process.execPath,
    ["./scripts/run-zerocopy-anneal-demo.mjs", ...wrapperArgs],
    {
      cwd: rootDir,
      env,
      stdio: "inherit",
    },
  );
  const demoExited = childExit(demoChild);

  try {
    await waitForExternalDemo(demoExited);
    console.log("[test:e2e:zerocopy-anneal] Running external demo browser tests.");
    playwrightChild = spawn("npx", ["playwright", "test", "--grep", "external demo"], {
      cwd: rootDir,
      env,
      stdio: "inherit",
    });
    const result = await childExit(playwrightChild);
    playwrightChild = null;
    if (forwardedSignal) {
      return forwardedSignal === "SIGINT" ? 130 : 143;
    }
    return result.code ?? 1;
  } finally {
    await stopChild(playwrightChild);
    await stopChild(demoChild);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (forwardedSignal) {
      process.exit(forwardedSignal === "SIGINT" ? 130 : 143);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
