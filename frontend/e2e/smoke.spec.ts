// Hermetic smoke test: login → game select. The worker backend is stubbed
// via page.route so this suite needs only the static frontend bundle —
// CI runs vite preview against a fresh build, no D1 / no miniflare.    // L2_實作

import { test, expect } from "@playwright/test";

const STUB_BASE = "http://localhost:9999";

test.use({
  // The bundled frontend reads VITE_WORKER_URL at build time. We set the
  // build-time value via webServer.env in playwright.config.ts; here we
  // only need a baseURL pointing at vite preview.
});

test("login form loads and submits to game-select screen", async ({ page }) => {
  // Intercept /auth/token to return a fake JWT — the frontend never
  // verifies the JWT itself, so any non-empty string lets it through.
  await page.route(`${STUB_BASE}/auth/token`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "stub.jwt.token", playerId: "alice", dailyBonus: 0 }),
    });
  });

  // Stub the wallet badge fetch so the post-login screen doesn't error out.
  await page.route(`${STUB_BASE}/api/me/wallet*`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        playerId: "alice",
        displayName: "alice",
        chipBalance: 1000,
        updatedAt: Date.now(),
        ledger: [],
        nextLedgerCursor: null,
      }),
    });
  });

  // Stub friend recommendations + invites + live rooms — they fire on
  // the select screen and would otherwise show error toasts.
  await page.route(`${STUB_BASE}/api/friends/recommendations`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ recommendations: [] }),
  }));
  await page.route(`${STUB_BASE}/api/rooms/invites`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ invites: [] }),
  }));
  await page.route(`${STUB_BASE}/api/rooms/live`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ rooms: [] }),
  }));
  await page.route(`${STUB_BASE}/api/dm/unread`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ unread: 0 }),
  }));

  await page.goto("/");

  // Login form: type a nickname and submit.
  const nameInput = page.locator("input[maxlength='16']");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("alice");
  await page.locator("button[type='submit']").click();

  // Game select screen renders three game cards. Each card carries one of
  // the three emoji icons; assert on those instead of i18n text so the
  // test stays robust across locale toggles.
  await expect(page.locator("text=🃏").first()).toBeVisible();
  await expect(page.locator("text=🀄").first()).toBeVisible();
  await expect(page.locator("text=♠️").first()).toBeVisible();
});
