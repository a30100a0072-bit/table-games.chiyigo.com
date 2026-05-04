# Manual acceptance checklist

事項由系統 / Bot 都已自動驗證，但 UI 需要真人在瀏覽器跑過一輪才算驗收完成。

## How to run

```powershell
# Terminal 1 — Worker + D1 + Queues local emulation
npm run dev

# Terminal 2 — frontend dev server (Vite, hot-reload)
cd frontend
npm run dev
```

開 http://localhost:5173，登入任一名字（會自動建錢包 +1000 籌碼）。

---

## chiyigo OIDC（等 chiyigo console 設定後）

- [ ] 登入頁點「使用 chiyigo 登入」→ 跳到 chiyigo IdP
- [ ] 完成 IdP 認證 → 回到 `/auth/callback` → 拿到 JWT
- [ ] 確認 `playerId` 是 `oidc:<sub>` 前綴
- [ ] silent refresh：靜置 ~1h 後仍能正常請求（背景刷 token）
- [ ] 三方登出：點登出 → 跳 chiyigo `end_session_endpoint` → 確認 chiyigo 那邊也登出

需 `OIDC_CLIENT_ID` 設定到 `wrangler.toml` 的 `[vars]` 與 `[env.production.vars]`，redirect_uri 白名單同時加 dev + production。

---

## Uno（PR 2 — commit 77200a5）

### 一般出牌
- [ ] 大廳卡片顯示「🎴 Uno · 經典出牌派對 · 2-4 人含 Bot 補位 · 💰 100 籌碼」
- [ ] 點 Uno 卡 → 進入匹配 → 3 秒後 Bot 補滿 4 人
- [ ] 起手 7 張，棄牌堆中央顯示頂張 + 當前色 pill
- [ ] 我的回合：合法的牌不會 dim、非法的會 dim 50%
- [ ] 點合法數字牌 → 直接打出，輪到下一家
- [ ] 點 Skip / Reverse / +2 → 效果生效（下家被跳過、方向反轉、下家拿 2 張）
- [ ] 點 Wild / Wild+4 → 跳出 ColorPicker 4 色按鈕，選色後出牌

### Draw / Pass
- [ ] 沒有合法牌時點「抽牌」→ 拿到 1 張，「過」按鈕變可按
- [ ] 抽到合法牌可直接打掉
- [ ] 抽完選擇「過」→ 輪到下一家

### 邊界
- [ ] 起手翻到 +2：第一個玩家進場直接拿 2 張並被跳過
- [ ] 2 人模式：reverse 等同 skip（自己連續兩回合）
- [ ] 牌堆耗盡時：自動洗棄牌堆繼續（觀察 drawPileCount 不會卡 0）
- [ ] 出最後一張牌 → ResultScreen 顯示「You won!」+ 籌碼變動

### Disconnect / Timeout
- [ ] 出牌前關掉 tab 60 秒不重連 → 結算 -200（forfeit penalty）
- [ ] 30 秒不行動 → Bot 自動代打（觀察 sysMsg / connMsg）

---

## Yahtzee（PR 3 — commit b0be439）

### 擲骰流程
- [ ] 大廳卡片顯示「🎲 快艇骰子 · 5 顆骰子 13 回合 · 💰 100 籌碼」
- [ ] 點卡 → 匹配 → 4 人滿
- [ ] 我的回合 status banner 顯示「你的回合 · 剩 3 次擲骰」
- [ ] 點「🎲 擲骰（剩 3 次）」→ 5 顆 Unicode 骰面 ⚀⚁⚂⚃⚄⚅ 顯示
- [ ] 點骰子 → toggle 黃色 ring + 上提（保留）
- [ ] 再點 Roll → 只重擲未保留的骰
- [ ] 第 3 次擲後 Roll 按鈕 disabled

### 記分卡
- [ ] 13 行記分卡顯示我的分 + 對手分（Yahtzee 公開資訊）
- [ ] 我的回合且已擲 → 空格出現「+N」preview badge
- [ ] preview 正確：⚀⚀⚂⚃⚄ 在 ones = +2、largeStraight = 0、smallStraight = 0、chance = 14
- [ ] 點 preview badge → 填入該格、輪到下一家
- [ ] 上半部 ones-sixes 累計 ≥ 63 → bonus 列顯示 35/35
- [ ] 第 5 顆同點（已填過 yahtzee 槽 ≠ 0）→ 觀察結算後 yahtzeeBonus 加 100

### 結算
- [ ] 4×13=52 回合滿 → 結算 ResultScreen
- [ ] 排名第一玩家 +300（=100×3 籌碼）
- [ ] yahtzeeDetail 在前端有顯示 totals + bonus 明細（如果 ResultScreen 接的話）

### Disconnect
- [ ] 中途斷線 → -200 forfeit、winner +200，其他人 0

---

## 觀戰 / Replay

- [ ] Uno / Yahtzee 進行中 → 從別人帳號用 spectator URL 進入 → 牌面隱藏（Uno）或公開（Yahtzee 是公開資訊）
- [ ] 一局結束後在 ReplaysModal 看得到該局
- [ ] 點開 replay 步進 → 每個 action 卡片顯示正確（PR 後續會補 Uno/Yahtzee 專屬描述文）

---

## 跨遊戲整合

- [ ] WalletBadge 流水帳本顯示 settlement 條目，reason 標籤正確
- [ ] StatsModal 戰績含 Uno + Yahtzee
- [ ] FriendsModal 推薦能跨 5 款遊戲找共玩夥伴
- [ ] Tournament（PR 後續會接）：Uno / Yahtzee 賽事建立 → 4 人 join → 三輪 → 派彩
