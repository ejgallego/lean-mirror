import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

const consumerRoot = process.env.PACKED_BROWSER_CONSUMER_ROOT;
if (!consumerRoot) {
  throw new Error("PACKED_BROWSER_CONSUMER_ROOT must identify the isolated consumer.");
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const frontendHost = process.env.PACKED_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.PACKED_FRONTEND_PORT ?? "4284";
const backendHost = process.env.PACKED_BACKEND_HOST ?? "127.0.0.1";
const backendPort = process.env.PACKED_BACKEND_PORT ?? "7470";

export default defineConfig({
  testDir: "./test/minimal-e2e",
  timeout: 60_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    baseURL: `http://${frontendHost}:${frontendPort}`,
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: [
    {
      command: "npm run demo:backend",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DEMO_FRONTEND_HOST: frontendHost,
        DEMO_FRONTEND_PORT: frontendPort,
        LEAN_DEMO_HOST: backendHost,
        LEAN_DEMO_PORT: backendPort,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://${backendHost}:${backendPort}/session`,
    },
    {
      command: `npm run preview -- --host ${frontendHost} --port ${frontendPort}`,
      cwd: consumerRoot,
      env: {
        ...process.env,
        VITE_LEAN_BACKEND_URL: `http://${backendHost}:${backendPort}`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://${frontendHost}:${frontendPort}`,
    },
  ],
});
