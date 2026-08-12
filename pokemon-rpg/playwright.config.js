// Playwright config (R23, D-07). `webServer` starts tools/serve.mjs and
// tears it down itself, so no shared browser daemon (chromux) is needed for
// automated verification - the test suite is fully self-contained.
import { defineConfig } from "@playwright/test";

const PORT = 4310;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 500, height: 800 },
  },
  webServer: {
    command: `node tools/serve.mjs ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
