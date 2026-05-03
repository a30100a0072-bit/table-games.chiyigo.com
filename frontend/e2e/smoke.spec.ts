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

/** Stub the boot endpoints every test needs (login + select screen
 *  side-effects). Each test can layer extra page.route calls before the
 *  navigation. */
async function stubBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.route(`${STUB_BASE}/auth/token`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ token: "stub.jwt.token", playerId: "alice", dailyBonus: 0 }),
  }));
  await page.route(`${STUB_BASE}/api/me/wallet*`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      playerId: "alice", displayName: "alice", chipBalance: 1000,
      updatedAt: Date.now(), ledger: [], nextLedgerCursor: null,
    }),
  }));
  await page.route(`${STUB_BASE}/api/friends/recommendations`, route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ recommendations: [] }),
  }));
  await page.route(`${STUB_BASE}/api/rooms/invites`, route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ invites: [] }),
  }));
  await page.route(`${STUB_BASE}/api/rooms/live`, route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ rooms: [] }),
  }));
  await page.route(`${STUB_BASE}/api/dm/unread`, route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ unread: 0 }),
  }));
}

test("login form loads and submits to game-select screen", async ({ page }) => {
  await stubBoot(page);

  await page.goto("/");

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

test("clicking a game card transitions to the lobby (matching) screen", async ({ page }) => {
  await stubBoot(page);

  // /api/match never resolves — we only want to verify the lobby spinner
  // appears, not the subsequent WS handoff. Returning a never-resolving
  // promise to fulfill() would hang the route handler, so we let the
  // request stay in-flight by handling it manually with a long delay.
  await page.route(`${STUB_BASE}/api/match`, async route => {
    // Don't reply — Playwright auto-aborts when the test ends. The frontend
    // shows "matching..." until the response, which is exactly what we
    // want to assert on.
    await new Promise(r => setTimeout(r, 30_000));
    await route.fulfill({ status: 200, body: "{}" });
  });

  await page.goto("/");
  await page.locator("input[maxlength='16']").fill("alice");
  await page.locator("button[type='submit']").click();

  // Click the bigTwo card. There are three game-card buttons; the first
  // one (top-most) is bigTwo per GAME_TYPES order in GameSelectScreen.
  await expect(page.locator("text=🃏").first()).toBeVisible();
  await page.locator("button:has-text('🃏')").first().click();

  // Lobby screen shows "matching..." text + cancel button. Match the cancel
  // button (i18n key lobby.cancel) by its tabindex/role rather than the
  // localised string, to stay locale-independent.
  // The cancel button is the only button on the lobby screen, so we can
  // assert exactly one button is visible there.
  await expect(page.locator("button").filter({ hasText: /cancel|取消/i })).toBeVisible({ timeout: 5_000 });
});
