# 桌遊連線平台 — 架構與實作步驟（大老二 / 麻將 / 德州撲克）

> Cloudflare Serverless 架構。所有狀態住在 Durable Object；D1 + Queue 負責持久化與結算。
> 最後更新：2026-05-01（Tournament + miniflare + admin freeze + 完整 i18n + PWA + 登出/凍結 UI）
>
> **部署狀態**：三款遊戲後端整合 ✅；DO 透過 IGameEngine 適配層支援 bigTwo / mahjong / texas ✅；三款遊戲 BotAI（含進階吃碰決策 + Texas 詐唬）✅；BOT_FILL 三款全啟用（3 秒補位）✅；前端三遊戲 UI 完整 ✅；CI/CD 全鏈路打通（D1 migration + Workers integration tests）✅；**ES256 JWKS + 多 key 輪換**；**籌碼錢包 + 流水帳本 + ANTE 門檻 + bailout + daily bonus + forfeit + admin freeze**；**Tournament 後端+前端（best-of-3 / 4 人 / 5% rake）**；**Mahjong 花牌補張**；**Texas 攤牌揭牌 + 邊池 UI**；**i18n 雙語 (zh-TW / en)**；**PWA (manifest + sw.js)**；**結構化 JSON log + /metrics + admin endpoints**
> **測試矩陣**：
>   - **Node 單元測試**：9 檔 / **110 案例**（BigTwo 13、Mahjong 14、Texas 16、Adapter 19、BotAI 15、auth 9、rateLimit 4、tournamentDO 7、gateway handler 13），全綠
>   - **Workers 整合測試**（vitest 4 + @cloudflare/vitest-pool-workers）：2 檔 / **6 案例**，真 workerd / miniflare runtime
>   - **總計 116 測試**
> **TypeScript**：src + test + frontend 三組 typecheck 皆 0 error；frontend `npm run build` 成功（206 KB / 64 KB gzip）
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

### ✅ 全部完成（2026-04-30 → 2026-05-01）

**Auth / 觀測性**
- ES256 JWKS + 多 key 輪換（`JWT_PRIVATE_JWK` 接 array、`/.well-known/jwks.json` 發布全部公鑰、`parsePrivateJwks` 拒絕重複 kid）
- 結構化 JSON log（`utils/log.ts`）涵蓋 token_issued / rate_limited / bailout_blocked / settlement_written / admin_* / tournament_* 等 events
- isolate-local counter `/metrics` 端點（tokens_issued / matches_started / settlements_written / settlement_failures / bailouts / daily_bonus / rate_limited / admin_adjustments + uptime）
- rate limiting token bucket（`utils/rateLimit.ts`）：token 10/min/IP、match 30/min/playerId、wallet 60/min/playerId、bailout 3/min/playerId
- JWK 輪換 SOP（`docs/jwk-rotation.md`）

**籌碼經濟**
- D1 schema：`users`（含 last_bailout_at / last_login_at / frozen_at / frozen_reason）+ `chip_ledger`（reason: settlement / signup / daily / bailout / tournament / adjustment；UNIQUE(player_id, game_id, reason) 冪等）
- `/auth/token` lazy 建錢包 + 開戶贈 1000 + 每日登入 +100（24h cooldown CAS）
- ANTE 門檻：`/api/match` 餘額不足回 402（bigTwo/mahjong 100、texas 200）
- `/api/me/bailout` 救濟金（餘額 < 100 + 24h cooldown 給 500，UPDATE 作 CAS）
- Disconnect = forfeit：mahjong/texas 棄局者 -100/-200，其他平分（守恆向下取整）；BigTwo 用既有 remaining-cards 計分
- Turn timeout = auto-action（不再炸整局）：BigTwo 自動 PASS 或 BotAI lead；Mahjong 用孤立度啟發式丟；Texas 直接 fold
- Admin 端點：`/api/admin/adjust`（CAS 防透支）、`/api/admin/freeze`、`/api/admin/unfreeze`、`/api/admin/users`（X-Admin-Secret + timing-safe compare）
- 前端 `WalletBadge` 顯示餘額 + 流水（含 reason 標籤）+ 救濟金按鈕；`StatsModal` 排行榜 + 戰績；登入頁顯示帳號被凍結原因；GameSelectScreen 登出按鈕

**遊戲核心擴充**
- 麻將台數精算：清一色(8) / 字一色(16) / 大三元(8) / 大四喜(16) / 槓上開花(1)（state 加 `drewFromKongReplacement` 旗標）
- 麻將花牌：`MahjongSuit` 加 `"f"`，8 張花牌（春夏秋冬+梅蘭竹菊）入牌牆；`drainFlowers`（開局頭抽）+ `drawNonFlower`（補嶺尾抽）自動補張；前端對手 `🌸 ×N`、自己花牌彩標
- 麻將 UI 完整：吃牌 modal（列出所有可吃組合）/ 暗槓 / 加槓 / 反應倒數
- Texas 攤牌揭牌：`PokerOpponentView.holeCards?` 限定 showdown/settled 階段才寫；前端對手底牌實牌渲染
- Texas 邊池 UI：每池獨立 pill + 「N 人爭奪」；加注 inline 提示（最低 / 底池倍 / 最高）
- BigTwo 5 牌型快捷鍵：對子 / 順子 / 葫蘆 / 鐵支 / 同花順（鍵盤 1-5、同鍵循環）
- BigTwo Bot lead 強化：≥6 張時主動 dump 最小 5-card 組合 + `pickLead` 三段保留 "2" 收尾
- Mahjong Bot 機會性吃碰：reaction phase 看 isolation 決定吃/碰、平常守 menqing
- Texas Bot 河牌詐唬：高牌 + checked-around 12% 機率小注（FNV hash 決定，replay 可重現）

**Tournament**
- D1 schema：`tournaments` + `tournament_entries`
- TournamentDO（一賽一實例）：init / 4 join 自動開賽 / round-result hook 累積分數 / 三輪後 settle 派彩
- 五個端點：POST `/api/tournaments`、GET `/api/tournaments`、POST `/api/tournaments/:id/join`、GET `/api/tournaments/:id`、+ TournamentDO 內 `/round-result`
- 前端 `TournamentModal`：列表 + 建立（gameType + 預設 buy-in 200/500/1000）+ 詳情（entries + 分數）+ 自動 join room；`🏆` 按鈕掛在 GameSelect

**前端工程**
- i18n（zh-TW + en）涵蓋全部畫面：`dict.ts`、`useT.ts`、`LocaleToggle.tsx`，~80 keys
- PWA：`public/sw.js`（cache-first 靜態 / 動態 bypass）+ `manifest.json`（含 SVG icons）+ install prompt + offline banner
- 登出按鈕（GameSelectScreen）/ 凍結帳號 UI（LoginScreen）

**測試 / 工程衛生**
- vitest 2 → 4 升級（110 既有測試零修改）
- **真 miniflare 整合**（`@cloudflare/vitest-pool-workers@0.15.x`）：`vitest.workers.config.mts`、`test/workers/{jwks,auth-flow}.test.ts` 6 案；CI 同步 gate
- DO 直接構造測試：`test/tournamentDO.test.ts` 7 案（lifecycle / payout / 平手）
- Handler 層：`test/gateway.handler.test.ts` 13 案（routing / auth / 籌碼經濟 / freeze / admin 含 mock D1）
- `.gitattributes`：commit 不再噴 CRLF 警告
- 死碼清理（MahjongStateMachine `indexToTile` / `isHonor`）

### ⏳ 真正剩下的

**需要外部資源**
1. ~~**Sentry / Cloudflare Logpush 接線**~~ — 完成（2026-05-01 第三批）：自帶 tail forwarder worker `big-two-log-forwarder`（`src/forwarder/index.ts` + `wrangler.forwarder.toml`），CI 在主 worker 部署前先部署；接通用 webhook（Discord / Slack / 任意 sink）。**只剩手動一步**：`wrangler secret put WEBHOOK_URL --config wrangler.forwarder.toml` 設你的 webhook URL；secret 未設則 forwarder 收到事件後直接 return（安靜無動作，不會壞主 worker）
2. ~~**OAuth 真登入**（Google / Apple）~~ — **延後**（2026-05-01 決議）：guest token + 帳號凍結 + ledger 已足夠跑 demo / 內測；待用戶量上來再啟動 IdP 申請

**麻將進階台（需狀態機改動，2026-05-01 後續再做）**
3. **搶槓** — 需要 `加槓` 加開反應視窗，目前只有 `kong/exposed` 與 `kong/concealed` 兩種未走 reaction window
4. **連莊 N** — 需要多局 dealer 傳遞與 round counter；單局結算不適用
5. **七搶一 / 八仙過海** — 需要 8 花直接終局與「第 8 花被搶」hook

### ✅ 後續補齊（2026-05-01 第四批 — 上線前合規）
- **帳號刪除 / GDPR**（`src/api/account.ts` + `src/workers/gateway.ts` 加 `DELETE /api/me` 路由 / CORS 允許 `DELETE` 與 `X-Confirm-Delete` header / `/auth/token` 加 `DELETED_` 前綴守關 / `frontend/src/api/http.ts` `deleteAccountApi` / `frontend/src/components/WalletBadge.tsx` 三段式刪除流程（連結 → 警告 → 輸入 `DELETE` 確認）/ `test/account.test.ts` 6 案）：混合策略——hard-delete `friendships/dms/room_invites/room_tokens/users`；anonymise `chip_ledger/player_settlements/games/tournament_entries/replay_meta` 為 `DELETED_<8-hex>` tombstone（保留會計與 replay 結構完整性，PII 蓋掉）；`replay_meta.player_ids` 用 JSON-quoted REPLACE 防 substring 誤撞；要求 `X-Confirm-Delete: yes` header 防 token 重放洗號

### ✅ 後續補齊（2026-05-01 第三批 — 觀測性）
- **Tail forwarder worker**（`src/forwarder/index.ts` + `wrangler.forwarder.toml` + `wrangler.toml` 加 `tail_consumers` + `.github/workflows/cloudflare-deploy.yml` 加先部署 step + `test/forwarder.test.ts` 11 案）：純 self-contained，獨立 worker `big-two-log-forwarder` 收 tail events，過濾後 POST 到 webhook。過濾規則：所有 exception + console error/warn + structured log event ∈ ALWAYS_FORWARD_EVENTS（admin_*、settlement_failed、bailout_granted、rate_limited、tournament_*_failed、match_blocked_frozen 等審計或異常事件）。Discord / Slack 同包（送 `{content, text}` 雙鍵），body 截 1500 字防超 Discord 2000 上限。secret 沒設 → no-op；不影響主 worker。

### ✅ 後續補齊（2026-05-01 第二批）
- **Texas 賽事升盲**（`src/do/TournamentDO.ts` `TEXAS_TOURNAMENT_BLINDS` / `src/do/GameRoomDO.ts` 加 `smallBlind/bigBlind` 進 `RoomMeta` + `/init` 驗證 / `frontend/src/components/TournamentModal.tsx` 顯示 R1/R2/R3 盲注 / `test/tournamentDO.test.ts` +2）：3 輪 10/20 → 20/40 → 50/100；非 texas 賽事不帶 blind 欄位；GameRoomDO `/init` 鎖 `gt==="texas" && bb≥sb*2`
- **觀戰 live listings**（`src/api/lobby.ts` LobbyDO 加 `liveRooms` Map + `idFromName("registry")` 走 `/register-live` `/unregister-live` `/live` / `src/do/GameRoomDO.ts` startGame 註冊 + cleanup 反註冊（純機器人房不上架）/ `src/workers/gateway.ts` 新 `GET /api/rooms/live`（無需 auth、不外洩玩家 id）/ `frontend/src/components/GameSelectScreen.tsx` 觀戰 modal 自動列表 + 10s 輪詢 / `test/liveRooms.test.ts` 5 案）
- **Friend DM**（`src/db/schema.sql` `dms` 表 + 三索引 / `src/api/dms.ts` send/inbox/unread / `src/utils/rateLimit.ts` `dm` bucket 30/min/sender / `src/workers/gateway.ts` 路由 / `frontend/src/api/http.ts` 三 helper / `frontend/src/components/FriendsModal.tsx` 內嵌 `DmPanel`（5s 輪詢、Enter 送出、≤500 字、自動 mark-as-read）/ `test/dms.test.ts` 10 案）：好友限定（DB JOIN 守關）+ 1v1 + 7 天保留 + 無 WS 推送（v1 走 polling）
- **麻將大眾規則 13 台 → bump `ENGINE_VERSION = 2`**（`src/game/MahjongStateMachine.ts` `calcFan` 重寫 / `src/game/GameEngineAdapter.ts` 版本+1 / `test/MahjongStateMachine.test.ts` +11 案）：補上 莊家 / 小三元 / 小四喜 / 三/四/五暗刻（食胡降級明刻）/ 全求人 / 花牌×N / 海底撈月 / 河底撈魚；state 加 `dealerIdx` `drewLastWallTile` `lastDiscardOnEmptyWall`；舊 replay row engine_version=1 自動標 `replayable=false`

### ✅ 後續補齊（2026-05-01 第一批）
- **Replay 視覺化播放器**（`frontend/src/components/ReplaysModal.tsx`）：每個事件渲染為帶卡牌/麻將牌符號 + badge 的 EventCard、Play/Pause/Step/Reset/Speed 1×–4× 控制、scrubber 任意跳轉、collapsed 完整事件清單可點擊跳轉
- **移動端 onboarding 統一**（`frontend/src/components/RotateHint.tsx` + 套到三遊戲畫面）：抽出共用 RotateHint 元件含 i18n 旋轉提示與「為什麼要橫向」說明；BigTwo / Mahjong / Texas 三家統一掛載
- **iOS Safari AudioContext unlock**（`frontend/src/shared/sound.ts` `unlockAudio` + LoginScreen 觸發）：登入按鈕 click handler 主動 resume() AudioContext + 零增益 blip 喚醒，避免後續對手動作觸發音效在 iOS 靜默
- **Tournament UI 增強**（`src/do/TournamentDO.ts` 加 `roundResults[]` / `src/api/tournaments.ts` getTournament 透出 + 新 `GET /api/me/tournaments` / `frontend/src/components/TournamentModal.tsx` 加每局分數矩陣 / `frontend/src/App.tsx` 15s 輪詢 + 進場提醒 banner / `test/tournamentDO.test.ts` +1）：DO 在 round-result 時把每位玩家的 scoreDelta 存入 `roundResults`，前端 modal 詳情頁顯示 R1 / R2 / R3 + 合計表格；App 在 select 畫面以 15 秒輪詢 my tournaments，若有 status=running 且 currentRoom 已派發但本次 session 未消費過的賽事，頂部彈出黃色「進場」banner，✕ dismiss 後該 (tournamentId, roomId) 加入本 session blacklist 不再顯示

### ✅ 本次補齊（2026-05-01 後續）
- **音效接 Mahjong + Texas**（`MahjongGameScreen.tsx` / `TexasHoldemGameScreen.tsx`）：myTurn / cardPlay / pass / win / lose 全 cue；BigTwo 既有實作不變
- **WS 訊框信封驗證**（`src/utils/wsFrame.ts` + `test/wsFrame.test.ts` 10 案）：信封層守 gameId / playerId / seq（非負整數）/ action.type 白名單；per-action 細節仍由各狀態機防禦。零新依賴（純 TS validator，不拉 zod）
- **DO alarm 時序 + Hibernation eviction 測試**（`test/gameRoomDO.test.ts` 4 案）：startGame 排 turn alarm、alarm() FUDGE 視窗、JSON-roundtrip safe、eviction 後新實例從同一 storage 重建並對 `/init` 回 409
- **wrangler 3 → 4.87** + Node 22 CI runner（`package.json` / `.github/workflows/cloudflare-deploy.yml`）：`npm audit` 從 1 high + 3 mod → 0
- **觀戰後端 + 前端**（`src/game/GameEngineAdapter.ts` / `src/do/GameRoomDO.ts` / `src/workers/gateway.ts` / `frontend/src/shared/GameSocket.ts` / `frontend/src/components/{GameSelectScreen,GameScreen,BigTwoGameScreen,MahjongGameScreen,TexasHoldemGameScreen}.tsx` / `test/spectatorView.test.ts` 3 案）：每引擎加 `getSpectatorView()` 把 self phantom 化、所有真玩家進 opponents（BigTwo 不外洩 hand、Mahjong 不外洩 exposed/flowers/hand、Texas 攤牌前不外洩 holeCards）；DO `?spectator=1` 走分支不佔座位、不觸發 startGame、丟掉 spectator 送的 action frame、斷線不算 forfeit；廣播時 spectator view per-broadcast 算一次後快取重用；前端 GameSelectScreen 右上加 👁️ 按鈕開觀戰 modal、輸入 roomId + gameType 即進場；三個 GameScreen 偵測 `spectator` prop 顯示「觀戰中」帶子、Texas 對自己底牌渲染 face-down，動作鈕因 currentTurn 永遠不等於觀戰者 JWT id 自然 disable；遊戲畫面右下浮動 📋 pill 一鍵複製房號（含 execCommand fallback）
- **好友系統**（`src/db/schema.sql` / `src/api/friends.ts` / `src/workers/gateway.ts` / `src/utils/rateLimit.ts` / `frontend/src/api/http.ts` / `frontend/src/components/{FriendsModal,GameSelectScreen}.tsx` / `test/friends.test.ts` 10 案）：bidirectional consent，schema canonicalise 為 `(a_id, b_id)` with `a_id < b_id` + `requester` 欄位區分 incoming/outgoing pending；5 endpoints `POST /api/friends/request` / `POST /:other/accept` / `POST /:other/decline` / `DELETE /:other` / `GET /api/friends`；對稱請求自動接受（雙方都送 request 立刻變 accepted）；rate limit 20/min per playerId；前端 FriendsModal 三 tab（已加 / 邀請 / 等待）+ 加好友 input + 錯誤訊息泡泡；GameSelectScreen 加 👥 按鈕
- **私人房連結**（`src/db/schema.sql` / `src/api/privateRooms.ts` / `src/workers/gateway.ts` / `frontend/src/api/http.ts` / `frontend/src/components/{PrivateRoomModal,GameSelectScreen}.tsx` / `frontend/src/App.tsx` / `test/privateRooms.test.ts` 9 案）：capability token 走 `room_tokens` 表（PK token、game_id/game_type/capacity/created_by、TTL 5 min ~ 7 d，預設 24 h）；`POST /api/rooms/private` 一次完成 DO `/init` + token 寫入（init 失敗不留孤兒 token）+ `GET /api/rooms/by-token/:token` 解析（404 unknown / 410 expired）；前端 PrivateRoomModal 兩 tab（建立 / 加入），建立後給含 `?join=<token>` 的可分享連結（複製含 fallback）+「我先進場」直接開房；URL deeplink：載入時偵測 `?join=`、登入後自動把該 token 帶進 modal 的「加入」分支，進場後從 history 移除 query 防 logout 重觸發；不經 lobby/ANTE，結算照常進 chip_ledger
- **房間邀請**（`src/db/schema.sql` / `src/api/roomInvites.ts` / `src/workers/gateway.ts` / `frontend/src/api/http.ts` / `frontend/src/components/{InvitesModal,PrivateRoomModal,GameSelectScreen}.tsx` / `test/roomInvites.test.ts` 10 案）：`room_invites(id, inviter, invitee, token, game_type, ts, status)` 表 + UNIQUE(inviter, invitee, token) 防重；3 endpoints `POST /api/rooms/invite { friendPlayerId, joinToken }` / `GET /api/rooms/invites` / `POST /api/rooms/invites/:id/decline`；invite 必須是已加好友 + token 未過期、accepting 是隱式（用 token 進房就是接受）；前端 PrivateRoomModal 建立後展開好友清單一鍵邀請、InvitesModal 拉收件箱（accept 時 re-resolve token 守住 race）、GameSelectScreen 加 📨 按鈕含未讀計數 badge（30s 輪詢）
- **Replay action log + engine_version stamp**（`src/db/schema.sql` / `src/game/GameEngineAdapter.ts` / `src/do/GameRoomDO.ts` / `src/api/replays.ts` / `src/workers/gateway.ts` / `frontend/src/api/http.ts` / `frontend/src/components/{ReplaysModal,GameSelectScreen}.tsx` / `test/replays.test.ts` 8 案 + `test/gameRoomDO.test.ts` +1）：`replay_meta(game_id PK, game_type, engine_version, player_ids, initial_snapshot, events, started_at, finished_at, winner_id, reason)`，每局一 row，事件流為 JSON array `{ kind, seq?, playerId?, action?, ts }`；GameRoomDO 在 startGame 抓 engine.snapshot()、每次 processAction / autoActionOnTimeout / 機器人移動 / 麻將反應 sweep 後 append event，settle 時 INSERT OR IGNORE 一次寫入（失敗不阻塞 SETTLEMENT_QUEUE）；新增 `ENGINE_VERSION` 常數於 adapter，演算法改動時 bump、舊版 row 仍可讀但 client 標 `replayable=false`、僅顯示結算；2 endpoints `GET /api/me/replays`（用 LIKE 配 JSON-quoted playerId 防 substring 誤撞）/ `GET /api/replays/:gameId`（403 非席位、404 unknown、版本不符隱藏 events 與 snapshot）；前端 ReplaysModal 列表+ 文字事件流（duck-type 渲染各遊戲動作）；GameSelectScreen 加 🎬 按鈕
- **賽事文件對齊現況**（`docs/tournament-design.md`）：從 "proposed" 改為 "shipped"，列 code map + 範圍切割
- **`WalletBadge` 補 `tournament: "賽事"` 標籤**

測試矩陣現況：**Node 單元 20 檔 / 205 案 + Workers 整合 2 檔 / 6 案 = 211 全綠**。`npm audit` 0 漏洞。

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

