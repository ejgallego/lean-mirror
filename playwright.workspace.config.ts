import { defineConfig } from "@playwright/test";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const frontendHost = process.env.WORKSPACE_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.WORKSPACE_FRONTEND_PORT ?? "4275";
export default defineConfig({
  testDir: "./test/workspace-e2e",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://${frontendHost}:${frontendPort}`,
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run example:workspace",
    env: {
      ...process.env,
      WORKSPACE_FRONTEND_HOST: frontendHost,
      WORKSPACE_FRONTEND_PORT: frontendPort,
      WORKSPACE_BACKEND_HOST: process.env.WORKSPACE_BACKEND_HOST ?? "127.0.0.1",
      WORKSPACE_BACKEND_PORT: process.env.WORKSPACE_BACKEND_PORT ?? "7461",
    },
    url: `http://${frontendHost}:${frontendPort}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
