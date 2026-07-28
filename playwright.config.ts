import { defineConfig, devices } from "@playwright/test";

const localBrowserChannel = process.platform === "win32" && !process.env.CI ? "msedge" : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: localBrowserChannel,
    launchOptions: {
      args: ["--enable-precise-memory-info"],
    },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "small-window",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 900, height: 700 },
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
