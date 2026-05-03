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

test("mahjong hand selector forwards mahjongHands into the match request", async ({ page }) => {
  await stubBoot(page);

  // Capture the request body so we can assert the selector wired through.
  // Hold the route open (matchmaking promise unresolved) — we don't need
  // a successful match here, only the request side of the contract.
  let capturedBody: string | null = null;
  await page.route(`${STUB_BASE}/api/match`, async route => {
    capturedBody = route.request().postData();
    await new Promise(r => setTimeout(r, 30_000));
    await route.fulfill({ status: 200, body: "{}" });
  });

  await page.goto("/");
  await page.locator("input[maxlength='16']").fill("alice");
  await page.locator("button[type='submit']").click();

  await expect(page.locator("text=🀄").first()).toBeVisible();

  // Mahjong card has a sibling row of 1 / 4 / 8 / 16 buttons. Pick "4".
  // (1 is the default; without selecting another option we wouldn't know
  // whether the body field is populated by the selector or by the default
  // path, so explicitly clicking 4 is the meaningful assertion.)
  await page.locator("button", { hasText: /^4$/ }).first().click();
  await page.locator("button:has-text('🀄')").first().click();

  // Wait for the lobby screen so we know the request fired before reading.
  await expect(page.locator("button").filter({ hasText: /cancel|取消/i })).toBeVisible({ timeout: 5_000 });

  expect(capturedBody, "/api/match request body").not.toBeNull();
  const parsed = JSON.parse(capturedBody!) as { gameType?: string; mahjongHands?: number };
  expect(parsed.gameType).toBe("mahjong");
  expect(parsed.mahjongHands).toBe(4);
});

test("BigTwo full-hand happy path: lobby → state injected → play → settlement", async ({ page }) => {
  await stubBoot(page);
  await page.route(`${STUB_BASE}/api/match`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      matched: true, roomId: "e2e-room-bigtwo", gameType: "bigTwo",
      players: ["alice", "BOT_2", "BOT_3", "BOT_4"],
    }),
  }));

  // Stub the WebSocket handshake. The frontend derives the WS url from
  // VITE_WORKER_URL (ws://localhost:9999/rooms/<roomId>/join) — we
  // intercept that, push a one-card state so the play action is the
  // only legal move, then settle on the first action frame the client
  // sends.                                                                 // L2_實作
  await page.routeWebSocket(/ws:\/\/localhost:9999\/rooms\/.*\/join/, ws => {
    ws.onMessage(raw => {
      const txt = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      let frame: { type?: string; action?: { type?: string } };
      try { frame = JSON.parse(txt); } catch { return; }
      // Ignore the periodic sync frame (`{type:"sync"}`) — we only
      // settle on real action frames so the timing isn't a race.
      if (frame.type === "sync") return;
      if (frame.action?.type === "play" || frame.action?.type === "pass") {
        ws.send(JSON.stringify({
          type: "settlement",
          payload: {
            gameId: "e2e-room-bigtwo", roundId: "r1",
            finishedAt: Date.now(), reason: "lastCardPlayed",
            players: [
              { playerId: "alice", finalRank: 1, remainingCards: [],                                                       scoreDelta:  300 },
              { playerId: "BOT_2", finalRank: 2, remainingCards: [{ suit: "clubs", rank: "3" }],                           scoreDelta: -100 },
              { playerId: "BOT_3", finalRank: 3, remainingCards: [{ suit: "clubs", rank: "4" }, { suit: "clubs", rank: "5" }], scoreDelta: -100 },
              { playerId: "BOT_4", finalRank: 4, remainingCards: [{ suit: "clubs", rank: "6" }, { suit: "clubs", rank: "7" }, { suit: "clubs", rank: "8" }], scoreDelta: -100 },
            ],
            winnerId: "alice",
          },
        }));
      }
    });

    // Initial state — alice holds a single 2-of-spades; her turn; lastPlay
    // null (any single is a legal lead). The hand has exactly one card so
    // any selection auto-detects the "single" combo.                        // L2_實作
    ws.send(JSON.stringify({
      type: "state",
      payload: {
        gameId:  "e2e-room-bigtwo",
        roundId: "r1",
        phase:   "playing",
        self:    { playerId: "alice", hand: [{ suit: "spades", rank: "2" }], cardCount: 1 },
        opponents: [
          { playerId: "BOT_2", cardCount: 5 },
          { playerId: "BOT_3", cardCount: 5 },
          { playerId: "BOT_4", cardCount: 5 },
        ],
        currentTurn:    "alice",
        lastPlay:       null,
        passCount:      0,
        turnDeadlineMs: Date.now() + 30_000,
      },
    }));
  });

  await page.goto("/");
  await page.locator("input[maxlength='16']").fill("alice");
  await page.locator("button[type='submit']").click();
  await expect(page.locator("text=🃏").first()).toBeVisible();
  await page.locator("button:has-text('🃏')").first().click();

  // After the state frame, the "your turn" pill should appear (locale-
  // independent regex). Use it as the ready signal before clicking. 8s
  // accommodates build-server cold start on CI.
  await expect(page.locator("text=/your turn|輪到你了/i").first()).toBeVisible({ timeout: 8_000 });

  // The hand contains a single card (2♠). PlayingCard renders as a
  // <button> whose visible glyphs are "2" + "♠". Pick it by suit symbol —
  // ♠ is unique to the card on this screen. Selecting it auto-detects
  // the "single" combo and enables the Play button.
  await page.locator("button", { hasText: "♠" }).first().click();

  const playBtn = page.locator("button").filter({ hasText: /出牌|Play/ }).first();
  await expect(playBtn).toBeEnabled({ timeout: 3_000 });
  await playBtn.click();

  // Settlement frame arrives → ResultScreen renders "You won!" / "你贏了！".
  await expect(page.locator("text=/you won|你贏了/i").first()).toBeVisible({ timeout: 8_000 });
});

test("successful match transitions lobby → game screen (WS connecting state)", async ({ page }) => {
  await stubBoot(page);

  // Stub /api/match with a real-shaped success payload. The frontend
  // derives the WS url from VITE_WORKER_URL (ws://localhost:9999/…),
  // which has nothing listening — GameSocket will fail to connect and
  // surface a "reconnecting" status. That's fine: we only need to
  // verify the GameScreen mounted.
  await page.route(`${STUB_BASE}/api/match`, route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      matched: true,
      roomId:  "e2e-room-bigtwo",
      gameType: "bigTwo",
      players: ["alice", "BOT_2", "BOT_3", "BOT_4"],
    }),
  }));

  await page.goto("/");
  await page.locator("input[maxlength='16']").fill("alice");
  await page.locator("button[type='submit']").click();

  await expect(page.locator("text=🃏").first()).toBeVisible();
  await page.locator("button:has-text('🃏')").first().click();

  // GameScreen's pre-state branch renders connMsg ("Connecting…" /
  // "連線中…") or, after the first failed attempt, "Reconnecting" /
  // "重新連線中…". Either is acceptable proof the screen mounted.
  // Match either localisation string.
  await expect(
    page.locator("text=/connecting|reconnecting|連線中|重新連線中/i").first()
  ).toBeVisible({ timeout: 8_000 });

  // The lobby's cancel button must NOT be on screen anymore — proves we
  // really transitioned past the lobby.
  await expect(page.locator("button").filter({ hasText: /^(cancel|取消)$/i }))
    .toHaveCount(0);
});
