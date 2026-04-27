# 桌遊連線平台 — 架構與實作步驟（大老二 / 麻將 / 德州撲克）

> Cloudflare Serverless 架構。所有狀態住在 Durable Object；D1 + Queue 負責持久化與結算。
> 最後更新：2026-04-27
>
> **部署狀態**：三款遊戲後端整合 ✅；DO 透過 IGameEngine 適配層支援 bigTwo / mahjong / texas；CI/CD ✅
> **單元測試**：4 檔 / 58 案例（Big Two 13、Mahjong 14、Texas Hold'em 16、Adapter 15），全綠
> **Worker URL**：`https://big-two-game-production.a30100a0072.workers.dev`
> **Version ID**：`6c421e01-df5c-422c-baa4-763c25a0e4c0`
> `https://github.com/a30100a0072-bit/table-games.chiyigo.com`
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
│   ├── GameEngineAdapter.ts           ✅ IGameEngine 統一介面 + 三引擎工廠 / restore
│   └── BotAI.ts                       ✅ O(N) 貪心機器人 AI（Big Two；其它遊戲暫無）
├── do/
│   └── GameRoomDO.ts                  ✅ Durable Object — 多遊戲房間（透過 IGameEngine 派遣）
├── api/
│   └── lobby.ts                       ✅ 配對大廳邏輯 (LobbyDO + handleMatch，10s Bot 補位)
├── utils/
│   └── auth.ts                        ✅ JWT 工具 (verifyJWT + signJWT / HS256 / Web Crypto)
├── client/
│   └── GameSocket.ts                  ✅ 前端 SDK（斷線重連 + 指數退避）
├── workers/
│   ├── gateway.ts                     ✅ HTTP Worker — 路由 / CORS / WS 升級入口 / POST /auth/token
│   └── settlementConsumer.ts          ✅ Queue Consumer — 冪等寫入 D1
├── db/
│   └── schema.sql                     ✅ D1 建表 DDL
└── index.ts                           ✅ Worker 主入口（路由綁定）

frontend/                              ✅ React 18 + Vite 5 + Tailwind 3 (PWA)
├── src/
│   ├── main.tsx                       ✅ ReactDOM 入口
│   ├── App.tsx                        ✅ 畫面狀態機 (login → lobby → game → result)
│   ├── index.css                      ✅ Tailwind 指令 + hand-scroll 隱藏捲軸
│   ├── api/
│   │   └── http.ts                    ✅ getToken() / findMatch() fetch 封裝
│   ├── shared/
│   │   ├── types.ts                   ✅ 遊戲型別（瀏覽器安全副本）
│   │   └── GameSocket.ts              ✅ WS 客戶端（同 src/client，import 路徑已調整）
│   └── components/
│       ├── LoginScreen.tsx            ✅ 暱稱輸入
│       ├── LobbyScreen.tsx            ✅ 等待配對動畫
│       ├── GameScreen.tsx             ✅ 主遊戲畫面（CardView/HandView/TableDisplay/ActionBar）
│       └── ResultScreen.tsx          ✅ 排名 + 分數結算
└── .env.example                       VITE_WORKER_URL 環境變數範例

test/
├── BigTwoStateMachine.test.ts         ✅ 13 案例（合法出牌/非法阻擋/結算觸發）
├── MahjongStateMachine.test.ts        ✅ 14 案例（canWin 純函式 / 動作分派 / 反應視窗）
├── TexasHoldemStateMachine.test.ts    ✅ 16 案例（牌型階序 / 7 取 5 / 邊池 / 動作驗證）
└── GameEngineAdapter.test.ts          ✅ 15 案例（工廠 / snapshot 往返 / forceSettle / 動作防呆）

wrangler.toml                          ✅ CF 資源綁定宣告（含 [env.production] 完整重複）
```

### 完成進度摘要

| Step | 檔案 | 狀態 | 重點 |
|------|------|------|------|
| 1 | `types/game.ts` | ✅ | `PlayerAction`、`GameStateView`（視角隔離）、`SettlementResult` |
| 2 | `game/BigTwoStateMachine.ts` | ✅ | 洗牌無 modulo bias、牌型驗證、`snapshot()`/`restore()`、`forceSettle()` |
| 3 | `do/GameRoomDO.ts` | ✅ | WS Hibernation API、多工虛擬計時器、60s 斷線緩衝、`deleteAll()` 防幽靈計費 |
| 4 | `utils/auth.ts` | ✅ | HS256 / Web Crypto、`verifyJWT` + `signJWT`、`JWTError` 獨立型別 |
| 5 | `api/lobby.ts` | ✅ | 單一 LobbyDO 序列化、Long-poll、D1 失敗還原、MATCH_KV 防重複配對、10s Bot 補位 |
| 6 | `client/GameSocket.ts` | ✅ | 指數退避 + jitter、重連後自動 SYNC、`seq` 跨重連遞增、unsubscribe fn |
| 7 | `workers/gateway.ts` | ✅ | HTTP 路由、CORS 標頭、`POST /auth/token` 發 JWT、WS 升級轉發 |
| 8 | `db/schema.sql` | ✅ | D1 DDL：GameRooms / games / player_settlements + index |
| 9 | `workers/settlementConsumer.ts` | ✅ | INSERT OR IGNORE 冪等寫入、batch 原子、message.retry() |
| 10 | `src/index.ts` | ✅ | Worker 主入口、export DO、fetch + queue handler |
| 11 | `wrangler.toml` | ✅ | DO migrations (`new_sqlite_classes`)、Queue、KV、D1、JWT_SECRET、`[env.production]` |
| Bot | `game/BotAI.ts` | ✅ | `getBotAction(view, hand)`，O(N) greedy；5 張牌組合永遠 PASS |
| 12 | `frontend/` | ✅ | React 18 + Vite 5 + Tailwind 3，手機 / 桌機響應式，PWA manifest |
| MJ | `game/MahjongStateMachine.ts` | ✅ | 台灣 16 張：PENDING_REACTIONS 等待視窗、嚴格優先級（胡>槓>碰>吃）、O(N) 回溯胡牌判定 ≤ 1088 ops、吃碰槓胡逐項回查手牌防偽造（L2_隔離）|
| TH | `game/TexasHoldemStateMachine.ts` | ✅ | No-Limit Hold'em：`crypto.getRandomValues` 拒絕採樣洗牌、Side Pot Split（贏家不可超匹配額）、RAISE 嚴格驗證（≥currentBet+minRaise）、7 取 5 牌型評分（C(7,5)=21）|

| 工程支援 | 檔案 | 狀態 | 重點 |
|----------|------|------|------|
| 單元測試 (BT) | `test/BigTwoStateMachine.test.ts` | ✅ | 13 案例：合法出牌、非法牌型阻擋（6 種）、結算觸發（3 種） |
| 單元測試 (MJ) | `test/MahjongStateMachine.test.ts` | ✅ | 14 案例：`canWin` 6 案、初始化 3 案、動作分派 5 案；以 Mulberry32 種子 RNG 確定性 |
| 單元測試 (TH) | `test/TexasHoldemStateMachine.test.ts` | ✅ | 16 案例：牌型階序、wheel straight、kicker、7 取 5、邊池三層 / 棄牌貢獻、盲注、加注合法性 |
| CI/CD | `.github/workflows/cloudflare-deploy.yml` | ✅ | push main 觸發、tsc + vitest 通過後 wrangler deploy |

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
LoginScreen  ──(getToken)──►  LobbyScreen  ──(findMatch)──►  GameScreen  ──(settlement)──►  ResultScreen
  輸入暱稱                      等待配對                         主遊戲                          結算排名
                                                                    │
                                                             GameSocket (WS)
                                                             斷線自動重連
```

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
  │  POST /auth/token  → { token, playerId }
  │  POST /lobby/match → { roomId, wsUrl, players }
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
- **Bot 補位**：大廳等候 10 秒後自動填入 Bot，Bot 以 `BOT_1` ~ `BOT_3` 命名，1.5s 思考延遲；**僅 bigTwo 啟用**，mahjong/texas 不會塞 Bot（沒有對應 AI）。
- **多遊戲派遣**：客戶端打 `POST /api/match { gameType }` 或 `POST /rooms { gameType, capacity }`。LobbyDO `idFromName(gameType)` 確保各遊戲互不干擾的等候佇列。GameRoomDO 收 `gameType` 後委派 `createEngine` 建出 `IGameEngine`，後續所有 WS 訊息經 adapter 轉到對應狀態機。
- **forceSettle 語義**：mahjong / texas 在 timeout/disconnect 時採「中止退池」 — 所有玩家 `scoreDelta=0`、`reason` 在結算事件中區分；前端依 reason 顯示中止訊息。
- **免費方案 DO Migration**：必須使用 `new_sqlite_classes`（非 `new_classes`），否則 CF 回傳錯誤 10097。
- **wrangler 環境繼承**：`[env.production]` 不會繼承頂層 bindings，所有綁定須在 `[env.production]` 下完整重複宣告。
