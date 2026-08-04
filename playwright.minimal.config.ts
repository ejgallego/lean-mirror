import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const frontendHost = process.env.MINIMAL_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.MINIMAL_FRONTEND_PORT ?? "4274";
const backendHost = process.env.MINIMAL_BACKEND_HOST ?? "127.0.0.1";
const backendPort = process.env.MINIMAL_BACKEND_PORT ?? "7460";
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";

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
  webServer: {
    command: "npm run example:minimal",
    env: {
      ...process.env,
      MINIMAL_BACKEND_HOST: backendHost,
      MINIMAL_BACKEND_PORT: backendPort,
      MINIMAL_FRONTEND_HOST: frontendHost,
      MINIMAL_FRONTEND_PORT: frontendPort,
    },
    reuseExistingServer,
    timeout: 120_000,
    url: `http://${frontendHost}:${frontendPort}`,
  },
});
