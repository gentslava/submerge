import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const suppliedBaseURL = process.env.SUBMERGE_E2E_BASE_URL;
const baseURL = suppliedBaseURL ?? "http://127.0.0.1:5173";
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const webServer = suppliedBaseURL
  ? undefined
  : {
      command: "pnpm exec vite --host 127.0.0.1",
      cwd: webRoot,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // The fixtures share one Vite server. A single CI worker keeps teardown deterministic.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: "list",
  ...(webServer ? { webServer } : {}),
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
