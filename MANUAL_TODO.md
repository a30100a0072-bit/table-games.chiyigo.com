# Manual acceptance checklist

事項由系統 / Bot 都已自動驗證，但 UI 需要真人在瀏覽器跑過一輪才算驗收完成。

## How to run

```powershell
# Terminal 1 — Worker + D1 + Queues local emulation (root has no `dev` script).
npx wrangler dev --port 8787

# Terminal 2 — frontend dev server (Vite, hot-reload).
cd frontend
npx vite --host 127.0.0.1 --port 5173
```

開 http://127.0.0.1:5173，登入任一名字（會自動建錢包 +1000 籌碼）。

> Vite 一定要綁 `127.0.0.1`，不能用預設 `localhost` — Windows 上 v6/v4 解析會打到 wrangler 的 8787 失敗（已記在 memory `project_e2e_harness.md`）。

---

## chiyigo OIDC（等 chiyigo console 設定後）

- [x] 登入頁點「使用 chiyigo 登入」→ 跳到 chiyigo IdP
- [x] 完成 IdP 認證 → 回到 `/auth/callback` → 拿到 JWT（2026-05-09 通過）
- [x] 確認 `playerId` 是 `oidc:<sub>` 前綴（DevTools localStorage 看一眼）
- [x] silent refresh：靜置 ~1h 後仍能正常請求（背景刷 token）
- [x] 三方登出：點登出 → 跳 chiyigo `end_session_endpoint` → 確認 chiyigo 那邊也登出（2026-05-09 通過，含 RP→OP 方向）

> ⚠️ 兩個刻意不做的設計缺口（不是 bug）：
> 1. **沒有 silent SSO auto-login** — chiyigo 已登入時來到本站仍需再按一次登入鈕
> 2. **沒有 OP→RP backchannel/frontchannel logout** — chiyigo 端登出時，本站要等使用者重整或下次 silent refresh 撞 `invalid_grant` 才察覺
> 兩者皆評估後選擇不做（牌局中途被踢體驗差），未來要補時參考下方「未來選項」段。

需 `OIDC_CLIENT_ID` 設定到 `wrangler.toml` 的 `[vars]` 與 `[env.production.vars]`，redirect_uri 白名單同時加 dev + production。

### 註冊流程（2026-05-09 已對齊 chiyigo admin schema）

`client_id` 已敲定 `playing-games`（小寫英數+`-`，validator regex `^[a-z0-9][a-z0-9_-]{1,63}$`）。`wrangler.toml` 兩處 `OIDC_CLIENT_ID` 已預填，POST 成功後直接 `wrangler deploy` 即生效。

對 chiyigo admin endpoint POST：

```http
POST https://chiyigo.com/api/admin/oauth-clients
Authorization: Bearer <admin token with admin:clients:write>
Content-Type: application/json

{
  "client_id": "playing-games",
  "client_name": "玩牌遊戲（大老二 / 麻將 / 撲克 / Uno / Yahtzee）",
  "app_type": "web",
  "redirect_uris": [
    "https://big-two-frontend.pages.dev/auth/callback",
    "http://127.0.0.1:5173/auth/callback"
  ],
  "post_logout_redirect_uris": [
    "https://big-two-frontend.pages.dev/",
    "http://127.0.0.1:5173/"
  ],
  "frontchannel_logout_uris": [],
  "backchannel_logout_uri": null,
  "allowed_scopes": ["openid", "profile", "email"],
  "origins": ["https://big-two-frontend.pages.dev", "http://127.0.0.1:5173"],
  "aud": "playing-games"
}
```

預期 `201 { client_id: "playing-games" }`。

### 未來選項：參與 chiyigo 全域登出（OP→RP 反向）

目前 `frontchannel_logout_uris: []` / `backchannel_logout_uri: null` —
使用者在 chiyigo 或其他 RP 登出時，遊戲端不會即時收到通知，要等
silent refresh 撞 `invalid_grant` 才察覺。

刻意這樣選的原因：牌局中途被踢出 session 體驗很差，讓 refresh
自然過期更順。

未來若要參與，補一個 SPA 頁清 token 即可（chiyigo 用 hidden iframe
載入），不需要 backend：

- 前端新增 `/frontchannel-logout` 路由：清 localStorage token + 通知
  Worker 撤銷 refresh row
- chiyigo admin PATCH 此 client：
  `frontchannel_logout_uris: ["https://big-two-frontend.pages.dev/frontchannel-logout"]`

---

## Uno（PR 2 — commit 77200a5）

### 一般出牌
- [x] 大廳卡片顯示「🎴 Uno · 經典出牌派對 · 2-4 人含 Bot 補位 · 💰 100 籌碼」
- [x] 點 Uno 卡 → 進入匹配 → 3 秒後 Bot 補滿 4 人
- [x] 起手 7 張，棄牌堆中央顯示頂張 + 當前色 pill
- [x] 我的回合：合法的牌不會 dim、非法的會 dim 50%
- [x] 點合法數字牌 → 直接打出,輪到下一家
- [x] 點 Skip / Reverse / +2 → 效果生效（下家被跳過、方向反轉、下家拿 2 張）
- [x] 點 Wild / Wild+4 → 跳出 ColorPicker 4 色按鈕,選色後出牌

### Draw / Pass
- [x] 沒有合法牌時點「抽牌」→ 拿到 1 張,「過」按鈕變可按
- [x] 抽到合法牌可直接打掉
- [x] 抽完選擇「過」→ 輪到下一家

### 邊界
- [x] 起手翻到 +2：第一個玩家進場直接拿 2 張並被跳過
- [x] 2 人模式：reverse 等同 skip（自己連續兩回合）
- [x] 牌堆耗盡時：自動洗棄牌堆繼續（觀察 drawPileCount 不會卡 0）
- [x] 出最後一張牌 → ResultScreen 顯示「You won!」+ 籌碼變動

### 回合逾時（turn timeout，30s，line of defence #1）
- [x] 我的回合 30 秒不動作 → 後端自動以 BotAI 替我出牌/抽/過（觀察 sysMsg / connMsg）
- 注意：這是「回合逾時自動動作」（state machine `TURN_TIMEOUT_MS = 30_000`），玩家**沒有斷線**，仍坐在原座位

### 斷線寬限（reconnect grace,60s,line of defence #2）
- [x] 出牌前關掉 tab → 60 秒內回來不影響牌局
- [x] 60 秒不重連 → 結算 -200 forfeit penalty（`GameRoomDO.RECONNECT_MS = 60_000`）
- 注意：這條獨立於回合逾時；若斷線發生在我的回合,30s 回合逾時會先觸發 bot 代打,60s 才 forfeit

---

## Yahtzee（PR 3 — commit b0be439）

### 擲骰流程
- [x] 大廳卡片顯示「🎲 快艇骰子 · 5 顆骰子 13 回合 · 💰 100 籌碼」
- [x] 點卡 → 匹配 → 4 人滿
- [x] 我的回合 status banner 顯示「你的回合 · 剩 3 次擲骰」
- [x] 點「🎲 擲骰（剩 3 次）」→ 5 顆 Unicode 骰面 ⚀⚁⚂⚃⚄⚅ 顯示
- [x] 點骰子 → toggle 黃色 ring + 上提（保留）
- [x] 再點 Roll → 只重擲未保留的骰
- [x] 第 3 次擲後 Roll 按鈕 disabled（後端第 4 擲拒絕亦驗證）

### 記分卡
- [x] 13 行記分卡顯示我的分 + 對手分（Yahtzee 公開資訊）
- [x] 我的回合且已擲 → 空格出現「+N」preview badge
- [x] preview 正確：⚀⚀⚂⚃⚄ 在 ones = +2、largeStraight = 0、smallStraight = 0、chance = 14
- [x] 點 preview badge → 填入該格、輪到下一家
- [x] 上半部 ones-sixes 累計 ≥ 63 → bonus 列顯示 35/35
- [x] 第 5 顆同點（已填過 yahtzee 槽 ≠ 0）→ 觀察結算後 yahtzeeBonus 加 100

### 結算
- [x] 4×13=52 回合滿 → 結算 ResultScreen
- [x] 排名第一玩家 +300（=100×3 籌碼）
- [x] yahtzeeDetail 在前端有顯示 totals + bonus 明細

### 斷線寬限（reconnect grace，60s）
- [x] 中途斷線 60 秒不回 → -200 forfeit、winner +200，其他人 0（`RECONNECT_MS = 60_000`）
- 注意：回合逾時 30s（`TURN_TIMEOUT_MS`）會先觸發 BotAI 代擲/代填；玩家真斷線才會走到 60s forfeit

---

## 觀戰 / Replay

- [x] Uno / Yahtzee 進行中 → 從別人帳號用 spectator URL 進入 → 牌面隱藏（Uno）或公開（Yahtzee 是公開資訊）
- [x] 一局結束後在 ReplaysModal 看得到該局
- [x] 點開 replay 步進 → 每個 action 卡片顯示正確（Uno: 顏色 chip + 效果中文；Yahtzee: 保留位置 + 槽位中文）

---

## 跨遊戲整合

- [x] WalletBadge 流水帳本顯示 settlement 條目，reason 標籤正確
- [x] StatsModal 戰績含 Uno + Yahtzee
- [x] FriendsModal 推薦能跨 5 款遊戲找共玩夥伴
- [x] Tournament：Uno / Yahtzee 賽事建立 → 4 人 join → 三輪 → 派彩（已接，TournamentDO 含 it.each(["uno","yahtzee"]) 回歸測試；UI 在 TournamentModal 創建格已含兩款）
