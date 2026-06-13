import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "__tests__/webgpu",
  testMatch: "**/*.pw.ts",
  timeout: 30_000,
  webServer: {
    command: "bun vite --host 127.0.0.1 --port 5174 --mode test",
    url: "http://127.0.0.1:5174/__tests__/webgpu/harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 320, height: 320 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    launchOptions: {
      args: ["--enable-unsafe-webgpu"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
