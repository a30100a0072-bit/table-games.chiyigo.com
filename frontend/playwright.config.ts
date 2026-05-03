import { defineConfig } from "@playwright/test";

// Minimal Playwright config — single chromium project, vite preview
// auto-spawned. The worker backend is *not* started; tests stub
// /auth/token (and any other fetched endpoint) via page.route, which
// keeps the smoke suite hermetic + cheap to run in CI.                 // L2_實作
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Build-time worker URL. The smoke test stubs every request to this
      // origin via page.route — no real backend is contacted.            // L2_實作
      VITE_WORKER_URL: "http://localhost:9999",
    },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
