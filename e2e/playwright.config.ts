import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: "http://127.0.0.1:0",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch:
        /[\\/]specs[\\/](codex|projects|attention|remote|regression)[\\/](?!.*(?:\.desktop|connection|profile-switching)\.spec\.ts$).*\.spec\.ts/,
    },
    {
      name: "electron",
      use: { ...devices["Desktop Chrome"] },
      testMatch:
        /[\\/]specs[\\/](app[\\/].*|codex[\\/](?:.*\.desktop|connection|profile-switching)\.spec\.ts|projects[\\/].*\.desktop\.spec\.ts|attention[\\/].*\.desktop\.spec\.ts|remote[\\/].*\.desktop\.spec\.ts|regression[\\/].*\.desktop\.spec\.ts)/,
    },
  ],
});
