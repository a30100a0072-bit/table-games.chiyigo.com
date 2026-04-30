# 桌遊連線平台 — 架構與實作步驟（大老二 / 麻將 / 德州撲克）

> Cloudflare Serverless 架構。所有狀態住在 Durable Object；D1 + Queue 負責持久化與結算。
> 最後更新：2026-04-30（ES256 JWKS + 籌碼經濟 + 大老二快捷鍵）
>
> **部署狀態**：三款遊戲後端整合 ✅；DO 透過 IGameEngine 適配層支援 bigTwo / mahjong / texas ✅；三款遊戲皆有 BotAI ✅；BOT_FILL 三款全啟用（3 秒補位）✅；前端三遊戲 UI ✅；CI/CD 全鏈路打通（含 D1 schema migration）✅；**ES256 JWKS auth ✅**；**籌碼錢包 + 流水帳本 ✅**；**大老二 5 牌型快捷鍵 ✅**
> **單元測試**：5 檔 / 73 案例（Big Two 13、Mahjong 14、Texas Hold'em 16、Adapter 15、BotAI 15），全綠
> **TypeScript**：src + test + frontend 三組 typecheck 皆 0 error；frontend `npm run build` 成功
> **線上端點**：
>   - Worker：`https://big-two-game-production.a30100a0072.workers.dev`
>   - Pages：`https://big-two-frontend.pages.dev`（push master 自動 build + deploy）
> **Repo**：`https://github.com/a30100a0072-bit/table-games.chiyigo.com`
>
> **安全提醒**：GitHub Fine-grained PAT 請存入 Windows 認證管理員（`git config --global credential.helper manager`），勿明文寫入任何檔案。

---

## 專案目錄結構（最終）

```
src/
├── types/
│   └── game.ts                        ✅ 全域型別合約
├── game/
│   ├── BigTwoStateMachine.ts          ✅ 大老二純邏輯狀態機（零 IO）
│   ├── MahjongStateMachine.ts         ✅ 台灣 16 張麻將純邏輯（PENDING_REACTIONS）
│   ├── TexasHoldemStateMachine.ts     ✅ 德州撲克純邏輯（Side Pot Split）
│   ├── GameEngineAdapter.ts           ✅ IGameEngine 統一介面 + 三引擎工廠 / restore + tickReactionDeadline
│   └── BotAI.ts                       ✅ 三遊戲 BotAI（BigTwo 5 張組合搜索 / Mahjong 隔離度啟發式 + 必胡 / Texas Chen + pot odds）
├── do/
│   └── GameRoomDO.ts                  ✅ Durable Object — 多遊戲房間（透過 IGameEngine 派遣）
├── api/
│   └── lobby.ts                       ✅ 配對大廳邏輯 (LobbyDO + handleMatch，10s Bot 補位)
├── utils/
│   └── auth.ts                        ✅ JWT 工具 (ES256 ECDSA P-256 / JWKS / Web Crypto；含 jwksFromPrivateEnv)
├── client/
│   └── GameSocket.ts                  ✅ 前端 SDK（斷線重連 + 指數退避）
├── workers/
│   ├── gateway.ts                     ✅ HTTP Worker — 路由 / CORS / WS 升級入口 / POST /auth/token / GET /.well-known/jwks.json / GET /api/me/wallet / lazy-create user wallet
│   └── settlementConsumer.ts          ✅ Queue Consumer — 冪等寫入 D1 + chip_ledger atomic update
├── db/
│   └── schema.sql                     ✅ D1 建表 DDL（含 users 籌碼錢包 + chip_ledger 流水帳）
└── index.ts                           ✅ Worker 主入口（路由綁定）

scripts/
└── gen-jwk.mjs                        ✅ 一鍵產 ES256 P-256 私鑰 JWK（含 kid / alg / use）

frontend/                              ✅ React 18 + Vite 5 + Tailwind 3 (PWA)
├── src/
│   ├── main.tsx                       ✅ ReactDOM 入口
│   ├── App.tsx                        ✅ 畫面狀態機 (login → lobby → game → result)
│   ├── index.css                      ✅ Tailwind 指令 + hand-scroll 隱藏捲軸
│   ├── api/
│   │   └── http.ts                    ✅ getToken() / findMatch() fetch 封裝
│   ├── shared/
│   │   ├── types.ts                   ✅ 三遊戲型別合約（Big Two / Mahjong / Texas，瀏覽器安全副本）
│   │   ├── GameSocket.ts              ✅ WS 客戶端（同 src/client，import 路徑已調整）
│   │   └── bigTwoCombos.ts            ✅ 大老二快捷鍵牌型枚舉（pair/straight/fullHouse/fourOfAKind/straightFlush 由小到大）
│   ├── vite-env.d.ts                  ✅ ImportMetaEnv 型別宣告
│   └── components/
│       ├── LoginScreen.tsx            ✅ 暱稱輸入
│       ├── GameSelectScreen.tsx       ✅ 三遊戲選單（bigTwo / mahjong / texas）
│       ├── LobbyScreen.tsx            ✅ 等待配對動畫（攜帶 gameType + 取消返回）
│       ├── GameScreen.tsx             ✅ 路由器（依 gameType 派遣對應子畫面）
│       ├── BigTwoGameScreen.tsx       ✅ 大老二畫面（CardView/HandView/TableDisplay/ActionBar + 5 牌型快捷鍵 1–5 含循環提示）
│       ├── WalletBadge.tsx            ✅ 籌碼徽章（右上角顯示餘額；點擊展開最近 20 筆 ledger）
│       ├── MahjongGameScreen.tsx     ✅ 麻將畫面（牌面 m/p/s/z、副露、吃碰槓胡/自摸/過按鈕）
│       ├── TexasHoldemGameScreen.tsx ✅ 德撲畫面（底牌、公牌、底池/邊池、棄/過/跟/加/All-in）
│       └── ResultScreen.tsx          ✅ 排名 + 分數結算
└── .env.example                       VITE_WORKER_URL 環境變數範例

test/
├── BigTwoStateMachine.test.ts         ✅ 13 案例（合法出牌/非法阻擋/結算觸發）
├── MahjongStateMachine.test.ts        ✅ 14 案例（canWin 純函式 / 動作分派 / 反應視窗）
├── TexasHoldemStateMachine.test.ts    ✅ 16 案例（牌型階序 / 7 取 5 / 邊池 / 動作驗證）
├── GameEngineAdapter.test.ts          ✅ 15 案例（工廠 / snapshot 往返 / forceSettle / 動作防呆）
└── BotAI.test.ts                      ✅ 15 案例（三遊戲各 5：開牌/壓制/PASS/必胡/隔離捨棄）

wrangler.toml                          ✅ CF 資源綁定宣告（含 [env.production] 完整重複）
```

### 完成進度摘要

| Step | 檔案 | 狀態 | 重點 |
|------|------|------|------|
| 1 | `types/game.ts` | ✅ | `PlayerAction`、`GameStateView`（視角隔離）、`SettlementResult` |
| 2 | `game/BigTwoStateMachine.ts` | ✅ | 洗牌無 modulo bias、牌型驗證、`snapshot()`/`restore()`、`forceSettle()` |
| 3 | `do/GameRoomDO.ts` | ✅ | WS Hibernation API、多工虛擬計時器、60s 斷線緩衝、`deleteAll()` 防幽靈計費 |
| 4 | `utils/auth.ts` | ✅ | **ES256 ECDSA P-256** / Web Crypto、`signJWT(sub, privateJwk)` + `verifyJWT(token, jwks)` + `jwksFromPrivateEnv`、模組級 `CryptoKey` cache、`JWTError` 獨立型別 |
| 5 | `api/lobby.ts` | ✅ | 單一 LobbyDO 序列化、Long-poll、D1 失敗還原、MATCH_KV 防重複配對、3s Bot 補位、**ANTE 籌碼門檻（bigTwo/mahjong 100、texas 200，不足回 402）** |
| 6 | `client/GameSocket.ts` | ✅ | 指數退避 + jitter、重連後自動 SYNC、`seq` 跨重連遞增、unsubscribe fn |
| 7 | `workers/gateway.ts` | ✅ | HTTP 路由、CORS 標頭、`POST /auth/token` 發 ES256 JWT + lazy 建錢包（+1000）、`GET /.well-known/jwks.json` 發布公鑰、`GET /api/me/wallet` 回餘額 + 最近 20 筆 ledger、WS 升級轉發 |
| 8 | `db/schema.sql` | ✅ | D1 DDL：GameRooms / games / player_settlements / **users（籌碼錢包）/ chip_ledger（append-only 流水，UNIQUE(player_id,game_id,reason) 冪等）** + index |
| 9 | `workers/settlementConsumer.ts` | ✅ | INSERT OR IGNORE 冪等寫入、batch 原子、message.retry()、**結算同 transaction 寫 chip_ledger 並從 SUM(delta) 重算 users.chip_balance（bot 跳過）** |
| 10 | `src/index.ts` | ✅ | Worker 主入口、export DO、fetch + queue handler |
| 11 | `wrangler.toml` | ✅ | DO migrations (`new_sqlite_classes`)、Queue、KV、D1、**JWT_PRIVATE_JWK** secret、`[env.production]` |
| Bot | `game/BotAI.ts` | ✅ | 三遊戲 BotAI：`getBigTwoBotAction`（C(n,5) 5 張組合搜索 + 智能開牌）/ `getMahjongBotAction`（tile-utility 隔離度啟發式 + canWin 必胡 + 守 menqing）/ `getTexasBotAction`（Bill Chen 公式 preflop + 牌型 category + pot odds postflop） |
| 12 | `frontend/` | ✅ | React 18 + Vite 5 + Tailwind 3，手機 / 桌機響應式，PWA manifest |
| MJ | `game/MahjongStateMachine.ts` | ✅ | 台灣 16 張：PENDING_REACTIONS 等待視窗、嚴格優先級（胡>槓>碰>吃）、O(N) 回溯胡牌判定 ≤ 1088 ops、吃碰槓胡逐項回查手牌防偽造（L2_隔離）|
| TH | `game/TexasHoldemStateMachine.ts` | ✅ | No-Limit Hold'em：`crypto.getRandomValues` 拒絕採樣洗牌、Side Pot Split（贏家不可超匹配額）、RAISE 嚴格驗證（≥currentBet+minRaise）、7 取 5 牌型評分（C(7,5)=21）|

| 工程支援 | 檔案 | 狀態 | 重點 |
|----------|------|------|------|
| 單元測試 (BT) | `test/BigTwoStateMachine.test.ts` | ✅ | 13 案例：合法出牌、非法牌型阻擋（6 種）、結算觸發（3 種） |
| 單元測試 (MJ) | `test/MahjongStateMachine.test.ts` | ✅ | 14 案例：`canWin` 6 案、初始化 3 案、動作分派 5 案；以 Mulberry32 種子 RNG 確定性 |
| 單元測試 (TH) | `test/TexasHoldemStateMachine.test.ts` | ✅ | 16 案例：牌型階序、wheel straight、kicker、7 取 5、邊池三層 / 棄牌貢獻、盲注、加注合法性 |
| 單元測試 (Bot) | `test/BotAI.test.ts` | ✅ | 15 案例：BigTwo 開 3♣/ 最小壓制/ PASS / 5 張同花順壓同花/ 葫蘆無解；Mahjong 自摸胡/ 食胡/ 不胡 PASS/ 棄孤字/ 不在 awaiting 防呆；Texas AA 加注/ 7-2o 棄/ free-check/ 三條加注/ 高牌大額棄 |
| CI/CD | `.github/workflows/cloudflare-deploy.yml` | ✅ | push **master** 觸發 → tsc(src+test) + vitest → **`wrangler d1 execute --file=src/db/schema.sql --remote`（idempotent schema migration）** → `wrangler deploy --env production` → frontend `npm ci` + tsc + `vite build` → `wrangler pages project create big-two-frontend` (idempotent) → `wrangler pages deploy` |
| 前端多遊戲 | `frontend/src/components/{GameSelect,GameScreen,Mahjong,TexasHoldem}*` | ✅ | 三遊戲 UI 完整：選單→大廳→對應遊戲畫面；frontend `tsc` + `vite build` 通過 |
| GitHub Secrets | repo Settings → Secrets and variables → Actions | ✅ | `CLOUDFLARE_API_TOKEN`（含 Workers Scripts / D1 / Cloudflare Pages / Workers KV Storage / Queues 五項 Edit 權限）/ `CLOUDFLARE_ACCOUNT_ID` / `VITE_WORKER_URL` |

---

## 層級說明

| 層 | 檔案 | 職責 | IO |
|---|---|---|---|
| L0 SDK | `client/GameSocket.ts` | 前端連線管理、指數退避重連 | WebSocket |
| L1 型別 | `types/game.ts` | 全域合約，TS interface | 無 |
| L2 邏輯 | `game/BigTwoStateMachine.ts` | 大老二純狀態機，含牌型驗證 | 僅 `crypto.getRandomValues` |
| L2 邏輯 | `game/MahjongStateMachine.ts` | 麻將純狀態機，PENDING_REACTIONS + 胡牌回溯，含 snapshot/restore/forceSettle | 僅 `Math.random` 注入 |
| L2 邏輯 | `game/TexasHoldemStateMachine.ts` | 德州撲克純狀態機，Side Pot + 7 取 5，含 snapshot/restore/forceSettle | 僅 `crypto.getRandomValues` |
| L2 適配 | `game/GameEngineAdapter.ts` | `IGameEngine` 統一介面 + 三引擎 createEngine/restoreEngine 工廠 | 無 |
| L2 Bot | `game/BotAI.ts` | 純函式 AI，無副作用（Big Two only） | 無 |
| L3 房間 | `do/GameRoomDO.ts` | WS session、依 `gameType` 派遣 IGameEngine、推 Queue | WebSocket, Queue |
| L4 配對 | `api/lobby.ts` | **每 gameType 一個 LobbyDO**、Bot 補位（僅 bigTwo） | KV, D1, DO stub |
| L4 閘道 | `workers/gateway.ts` | HTTP 建房、JWT 發放、升級 WS、CORS | fetch, DO stub |
| L5 結算 | `workers/settlementConsumer.ts` | 消費 Queue 訊息、寫 D1 | Queue, D1 |
| L6 前端 | `frontend/` | React UI，手機 / 桌機，與後端 WS 通訊 | fetch, WebSocket |

---

## 前端架構

### 畫面狀態機
```
LoginScreen ─(getToken)─► GameSelectScreen ─(pick gameType)─► LobbyScreen ─(findMatch)─► GameScreen (router)
  輸入暱稱                  bigTwo / mahjong / texas             等待配對 + 取消               │
                                                                                           ├─ BigTwoGameScreen
                                                                                           ├─ MahjongGameScreen
                                                                                           └─ TexasHoldemGameScreen
                                                                                                   │
                                                                                            (settlement)
                                                                                                   ▼
                                                                                            ResultScreen
                                                                              GameSocket (WS) — 斷線自動重連
```

各遊戲 GameScreen 子畫面共用 `GameSocket`／`ResultScreen`，但 UI 元件（手牌、副露、底池、加注滑桿等）獨立實作。配對請求 `POST /api/match` body `{ gameType }`；回應 `{ roomId, gameType, players }`，前端以 `wsBase + /rooms/:roomId/join` 拼出 WebSocket URL。

### 本地開發
```bash
cp frontend/.env.example frontend/.env.local
# 編輯 VITE_WORKER_URL=https://big-two-game-production.a30100a0072.workers.dev
cd frontend && npm install && npm run dev
```

### 部署到 Cloudflare Pages
```bash
cd frontend && npm run build
# 方案 A：GitHub 整合（推薦）
#   Cloudflare Dashboard → Pages → Connect to Git → 選 repo
#   Build command: cd frontend && npm run build
#   Output directory: frontend/dist
#   Environment variable: VITE_WORKER_URL=https://...workers.dev

# 方案 B：手動推
wrangler pages deploy frontend/dist --project-name big-two-frontend
```

---

## 資料流總覽

```
Browser / Mobile (React PWA)
  │
  │  POST /auth/token       → { token, playerId }                 // ES256 JWT；伺服器同時 lazy 建 users 錢包 + 寫 signup ledger (+1000)
  │  GET  /.well-known/jwks.json → { keys: [public JWK] }         // Worker 自當 IdP，公鑰可驗證
  │  GET  /api/me/wallet    → { chipBalance, ledger:[…20 筆] }   // 帶 Authorization: Bearer
  │  POST /api/match        → { roomId, gameType, players }       // 先驗 chip_balance ≥ ANTE，不足回 402
  ▼
src/index.ts ──► handleMatch() ──► LobbyDO (idFromName "main")
                                        │  long-poll，湊齊 4 人（不足 10s 後 Bot 補位）
                                        ├─ INSERT GameRooms (D1)
                                        └─ Response { roomId, wsUrl, players }
  │
  │  WebSocket wss://...workers.dev/rooms/:gameId/join?token=xxx
  ▼
gateway.ts ──verifyJWT──► GameRoomDO
                              │
                              ├─ BigTwoStateMachine.processAction()
                              ├─ BotAI.getBotAction()（Bot 回合，1.5s 延遲）
                              ├─ broadcast viewFor(pid) → 各 Client
                              └─ settlement ──► Queue ──► settlementConsumer ──► D1
```

---

## 注意事項

- **視角隔離**：`GameStateView.opponents` 型別上不含 `hand`，TypeScript 層即強制隔離。
- **防重送**：`ActionFrame.seq` 單調遞增，DO 驗證 `seq > lastSeq` 才處理。
- **逾時鎖**：`turnDeadlineMs` 由 DO `setAlarm()` 實作，嚴禁 `setTimeout`。
- **無狀態 Worker**：gateway / index.ts 不持有任何對局狀態，全部在 DO 內。
- **SYNC 協定**：Client 重連後發 `{ type:"sync" }`，DO 回 `{ type:"state", payload }`。
- **Race Condition**：LobbyDO `idFromName("main")` 強制單一 JS 執行緒序列化配對邏輯。
- **CORS**：gateway.ts 所有 HTTP 回應均加 `Access-Control-Allow-Origin: *`，支援跨來源 Cloudflare Pages。
- **Token 傳遞**：瀏覽器 WebSocket 無法設自訂 header，token 附於 `?token=` query string。
- **ES256 JWKS 驗證**：Worker 用 `JWT_PRIVATE_JWK`（EC P-256 私鑰 JWK，含 `kid`）發 token；公鑰 (`kid` + `x` + `y`) 對外發布在 `/.well-known/jwks.json`。verifyJWT 從 token header 的 `kid` 對到 JWKS 內對應公鑰；模組級 `CryptoKey` cache 跨 request 重用。**本地用 `.dev.vars` 放開發 JWK，生產用 `wrangler secret put`，兩把要不同 `kid`。**
- **籌碼經濟冪等性**：`chip_ledger` 有 `UNIQUE (player_id, game_id, reason)`，Queue 重送 / 重複登入都自然 no-op；`users.chip_balance` 是從 ledger SUM 重算的衍生快取，所以即使 ledger insert 是 no-op、UPDATE 也算同樣的值，永遠不會重複加籌碼。Bot（`BOT_*` 前綴）完全不進 users / chip_ledger。
- **ANTE 籌碼門檻**：`api/lobby.ts` 匯出 `ANTE_BY_GAME = { bigTwo:100, mahjong:100, texas:200 }`；`handleMatch` 在 JWT 驗證後立刻查 `users.chip_balance`，不夠回 `402 Payment Required` + `{ balance, required, gameType }`，玩家不會被排進隊伍。前端 `findMatch` 把 402 轉成 `InsufficientChipsError` 顯示「需要 X 籌碼，目前 Y」。
- **大老二快捷牌型**：`frontend/src/shared/bigTwoCombos.ts` 純枚舉手上每種牌型（pair/straight/fullHouse/fourOfAKind/straightFlush）的所有可組合，由小到大；UI 提供鍵盤 1–5 + 5 個按鈕，第一次按選最小組合，同鍵再按循環下一組。**伺服器仍是權威**——選了不能壓對手的組合 server 還是會擋。
- **Bot 補位**：大廳等候 **3 秒**後自動填入 Bot，Bot 以 `BOT_1` ~ `BOT_3` 命名，1.5s 思考延遲（mahjong 反應動作 250ms）；**三款遊戲皆啟用**。
- **多遊戲派遣**：客戶端打 `POST /api/match { gameType }` 或 `POST /rooms { gameType, capacity }`。LobbyDO `idFromName(gameType)` 確保各遊戲互不干擾的等候佇列。GameRoomDO 收 `gameType` 後委派 `createEngine` 建出 `IGameEngine`，後續所有 WS 訊息經 adapter 轉到對應狀態機。
- **forceSettle 語義**：mahjong / texas 在 timeout/disconnect 時採「中止退池」 — 所有玩家 `scoreDelta=0`、`reason` 在結算事件中區分；前端依 reason 顯示中止訊息。
- **Bot 補位**（**3 秒**）：`api/lobby.ts` 對三款遊戲皆啟用 BOT_FILL，3 秒湊不到真人就自動補 `BOT_1` ~ `BOT_3`。BigTwo 用 1.5s 思考延遲；Mahjong 反應動作（吃碰胡）走 250ms 短延遲。
- **Mahjong 反應視窗 alarm**：DO 在 `phase === pending_reactions` 時改用 `react` alarm 對齊 `reactionDeadlineMs`（3.5s），到期呼叫 `engine.tickReactionDeadline()`（=`forceResolveReactions`）把未回應者視為過水；不再誤觸 `turn` alarm 把整局 forceSettle("timeout")。
- **MATCH_KV 生命週期**：`GameRoomDO.cleanup()` 在房間結束時刪掉所有真人的 `room:{pid}` KV 鍵，玩家可立即重新配對；`handleMatch` 若 KV 還在但 D1 顯示 settled / 房間消失，自動清掉再進大廳。
- **免費方案 DO Migration**：必須使用 `new_sqlite_classes`（非 `new_classes`），否則 CF 回傳錯誤 10097。
- **wrangler 環境繼承**：`[env.production]` 不會繼承頂層 bindings，所有綁定須在 `[env.production]` 下完整重複宣告。

---

## 已知問題 / 待辦清單（截至 2026-04-30 ES256 + 籌碼經濟版）

### ✅ 本次完成（2026-04-30）
1. **ES256 + JWKS 取代 HS256**（`src/utils/auth.ts` / `src/workers/gateway.ts` / `src/api/lobby.ts`）
   - HS256 對稱共享密鑰 → ECDSA P-256 非對稱簽章；Worker 自當 IdP
   - 對外發布 `GET /.well-known/jwks.json` 公鑰文件（含 `kid` 輪換能力）
   - WebCrypto 直接做（無新增 npm 依賴）；模組級 `CryptoKey` cache 跨 request 重用
   - `JWT_SECRET` → `JWT_PRIVATE_JWK`（私鑰 JWK JSON）
   - 新增 `scripts/gen-jwk.mjs` + `npm run gen:jwk` 一鍵產生私鑰
2. **籌碼錢包 + 不可變流水帳本**（`src/db/schema.sql` / `src/workers/settlementConsumer.ts` / `src/workers/gateway.ts`）
   - 新增 `users`（display_name / chip_balance / 時間戳）+ `chip_ledger`（append-only，UNIQUE(player_id,game_id,reason) 確保 Queue 重送冪等）
   - `/auth/token` lazy 建錢包 + 開戶贈送 1000 籌碼（寫 signup ledger）
   - `settlementConsumer` 在同一個 `db.batch()` transaction 內：寫 games / player_settlements / chip_ledger / 從 SUM(delta) 重算 users.chip_balance；Bot（`BOT_*`）完全跳過
   - 新增 `GET /api/me/wallet` 端點（餘額 + 最近 20 筆 ledger）
3. **ANTE 籌碼門檻 + 前端錢包 UI**（`src/api/lobby.ts` / `frontend/src/components/WalletBadge.tsx` / `GameSelectScreen.tsx`）
   - `ANTE_BY_GAME = { bigTwo:100, mahjong:100, texas:200 }`；不夠回 402 + `{ balance, required, gameType }`
   - 右上角 `WalletBadge`：顯示餘額，點擊展開最近 20 筆 ledger（含 reason 標籤 + 時間 + 正負色）
   - 遊戲卡片顯示「最低 X 籌碼」標示
   - `findMatch` 把 402 轉成 `InsufficientChipsError`（「需要 X 籌碼，目前 Y」）
4. **大老二 5 牌型快捷鍵 + 提示**（`frontend/src/shared/bigTwoCombos.ts` / `BigTwoGameScreen.tsx`）
   - 鍵盤 1–5：對子 / 順子 / 葫蘆 / 鐵支 / 同花順；同鍵連按循環下一組（cycle hint）
   - 純函式枚舉每種牌型由小到大候選；按鈕顯示「N 組」or「2/3」
   - 沒有可用的牌型自動 disable + 灰掉
5. **CI 加 D1 schema migration**（`.github/workflows/cloudflare-deploy.yml`）
   - 新增 step `wrangler d1 execute --file=src/db/schema.sql --remote` 在 Worker deploy 前跑
   - 全部 DDL 是 `IF NOT EXISTS`，重跑無副作用，新欄位/表會冪等套用

### ⏳ 仍未動（下次優先）
1. **麻將台數精算**（`MahjongStateMachine.ts:142`）— 清一色 / 字一色 / 大三元 / 大四喜 / 槓上開花尚未實作；目前只有平胡 + 自摸 + 門前清
2. **麻將 UI 缺件**：吃（chow）的「選 2 張手牌組順子」選擇器、暗槓 / 加槓獨立按鈕、reaction 倒數計時顯示
3. **德撲 UI 缺件**：showdown 揭牌動畫、最小加注金額 inline 提示
4. **整合測試零覆蓋**：`GameRoomDO`、`gateway.ts`、`api/lobby.ts`、前端皆無測試；無 e2e；籌碼經濟流程也沒測
5. **`.gitattributes`** 缺：每次 commit 都跳 LF→CRLF 警告（無功能影響）
6. **rate limiting**：`/auth/token`、`/api/match`、`/api/me/wallet` 無防刷；結構化 log / metrics 都缺
7. **Bot 進階**：
   - Big Two 仍是 minimum-beat 策略，沒有「保留大牌等收尾」、「主動領 5 張組合」的決策
   - Mahjong 永遠不吃碰槓（保 menqing）— 對手實際被 bot 餵牌時無法強壓節奏
   - Texas 不會詐唬、無對手範圍建模、3-bet 認知缺失
8. **籌碼經濟尚缺**：管理員調整端點、贈送 / 兌換、防範棄局逃避扣分（disconnect 算 forfeit?）、daily login bonus
9. **死碼**：`MahjongStateMachine.ts` 的 `indexToTile`、`isHonor` 仍未引用
10. **JWK 輪換**：JWKS 已支援多 `kid`，但 sign 路徑只用單一私鑰；尚無雙金鑰並存（舊 verify、新 sign）的 rotation 流程

---

## 下次新對話的開場指令（建議範本）

清除聊天後新開一個對話，把下面這段整段貼給 Claude（**重點 1：先讀架構、再動手**；**重點 2：人機 AI 拉到頂**）：

```
這是 Cloudflare Serverless 三遊戲對戰專案（大老二 / 台灣 16 張麻將 / 德州撲克），
請依下列順序進行，每階段做完先給我精簡報告再進下一階段：

【階段 1：全棧靜態審查（不改 code，先輸出評估）】
1. 讀 ARCHITECTURE.md 全文、wrangler.toml、package.json、.github/workflows/cloudflare-deploy.yml
2. 掃 src/ 全部 .ts、test/ 全部 .ts、frontend/src/ 全部 .ts/.tsx
3. 列出三層風險：
   - L1 阻擋上線 / 會掉資料 / 安全漏洞（必修）
   - L2 影響可玩性 / 功能不完整（強烈建議）
   - L3 程式碼風格 / 死碼 / 未來才需要（暫緩）
4. 不要動手改任何檔案；只交評估報告

【階段 2：人機 AI 強化（這是核心目標）】
目標 — 把三款遊戲的 Bot AI 強化到你能在「DO 50ms CPU 預算 / Cloudflare Workers 10 ms CPU 限制」內做到的最高強度，並在 api/lobby.ts 開啟麻將 / 德撲的 BOT_FILL，讓單人也能玩。

具體要求：
- Big Two：從現在 greedy 升級到 minimax / monte-carlo（限時內），含 5 張組合搜索
- 麻將：實作打牌啟發式（聽牌距離 shanten 計算 + 安全牌偏好 + 副露決策）；canWin 已有，可直接用
- 德州撲克：preflop 用 push/fold 表 + postflop 用 pot odds / 簡化 EV；至少要打贏全 fold 對手
- 每款 AI 要有對應 unit tests（≥3 案：明顯該打哪、明顯不該打哪、邊界）
- src tsc + test tsc + frontend tsc + npm test 全部要綠才 commit

【階段 3：commit + push】
1. 通過所有 typecheck + tests 後 commit
2. push origin master 觸發 CI（會同時 deploy Worker + Pages）
3. 等 CI 綠燈後告訴我結果

【背景資訊】
- 線上端點：Worker https://big-two-game-production.a30100a0072.workers.dev
            Pages  https://big-two-frontend.pages.dev
- 目前測試 58/58 通過、TypeScript 0 error
- 已知 ARCHITECTURE.md「已知問題 / 待辦清單」B 項：用戶實測「玩起來不太對」，
  但細節未提供 — 請在階段 1 報告中列出你「最可能壞掉」的 5 個地方，等我確認後再處理。
```

