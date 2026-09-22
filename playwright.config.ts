import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: ".artifacts/playwright-report", open: "never" }],
  ],
  outputDir: ".artifacts/playwright-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--disable-gpu"] },
      },
    },
  ],
});
