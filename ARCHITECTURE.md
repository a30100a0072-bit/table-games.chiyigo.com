# 大老二連線遊戲 — 架構與實作步驟

> Cloudflare Serverless 架構。所有狀態住在 Durable Object；D1 + Queue 負責持久化與結算。
> 最後更新：2026-04-26

---

## 專案目錄結構（最終）

```
src/
├── types/
│   └── game.ts                        ✅ 全域型別合約
├── game/
│   └── BigTwoStateMachine.ts          ✅ 純邏輯狀態機（零 IO）
├── do/
│   └── GameRoomDO.ts                  ✅ Durable Object — 房間生命週期 + WS 管理
├── api/
│   └── lobby.ts                       ✅ 配對大廳邏輯 (LobbyDO + handleMatch)
├── utils/
│   └── auth.ts                        ✅ JWT 驗證工具 (HS256 / Web Crypto)
├── client/
│   └── GameSocket.ts                  ✅ 前端 SDK（斷線重連 + 指數退避）
├── workers/
│   └── gateway.ts                     ⬜ HTTP Worker — 路由 / WS 升級入口
│   └── settlementConsumer.ts          ⬜ Queue Consumer — 寫入 D1
├── db/
│   └── schema.sql                     ⬜ D1 建表 DDL
└── index.ts                           ⬜ Worker 主入口（路由綁定）
wrangler.toml                          ⬜ CF 資源綁定宣告
```

---

## 層級說明

| 層 | 檔案 | 職責 | IO |
|---|---|---|---|
| L1 型別 | `types/game.ts` | 全域合約，TS interface | 無 |
| L2 邏輯 | `game/BigTwoStateMachine.ts` | 純狀態機，含牌型驗證 | 僅 `crypto.getRandomValues` |
| L3 房間 | `do/GameRoomDO.ts` | WS session 管理、呼叫 L2、推 Queue | WebSocket, Queue |
| L4 配對 | `api/lobby.ts` | 等候室、配對、防 Race Condition | KV, D1, DO stub |
| L4 閘道 | `workers/gateway.ts` | HTTP 建房、升級 WS、轉發至 DO | fetch, DO stub |
| L5 結算 | `workers/settlementConsumer.ts` | 消費 Queue 訊息、寫 D1 | Queue, D1 |
| L0 SDK | `client/GameSocket.ts` | 前端連線管理、指數退避重連 | WebSocket |

---

## 實作步驟

### Step 1 — 型別合約 ✅
**檔案：** `src/types/game.ts`

- `PlayerAction` — 出牌 / Pass 聯合型別，含 `ActionFrame`（序號防重送）
- `GameStateView` — 視角隔離快照（`SelfView` 含完整手牌；`OpponentView` 只含張數）
- `SettlementResult` — 結算格式，對接 D1 Queue
- `SettlementQueueMessage` — Queue 訊息包裝

---

### Step 2 — 純邏輯狀態機 ✅
**檔案：** `src/game/BigTwoStateMachine.ts`

- 安全洗牌：`crypto.getRandomValues` + rejection sampling（無 modulo bias）
- 發牌：52 張全部派出，3♣ 持有者先手
- 牌型偵測：single / pair / triple / straight / flush / fullHouse / fourOfAKind / straightFlush
- 比牌：同類別才能壓（5 張只能壓 5 張）；分數由 `score` 欄位決定
- 防禦：不在手牌的牌、非法牌型、非本人回合、Phase 錯誤，全部 throw
- 首輪強制含 3♣；全 Pass 後桌面重置
- `snapshot()` / `static restore()` — DO hibernation 序列化支援
- `forceSettle(reason)` — 供 DO 在逾時 / 斷線時呼叫

---

### Step 3 — Durable Object 房間 ✅
**檔案：** `src/do/GameRoomDO.ts`

- WebSocket Hibernation API（`webSocketMessage` / `webSocketClose` / `webSocketError`）
- `blockConcurrencyWhile(hydrate)` — 休眠喚醒後重建狀態
- `state.storage.setAlarm()` — 多工虛擬計時器（`AlarmEntry[]`）；禁用 setTimeout
- 斷線緩衝：60 秒重連視窗；逾期呼叫 `forceSettle("disconnect")`
- SYNC 訊息：收到 `{ type:"sync" }` 立即回傳 `getView(playerId)`
- 結算後 `SETTLEMENT_QUEUE.send()` → `state.storage.deleteAll()`（防幽靈計費）

---

### Step 4 — JWT 工具 ✅
**檔案：** `src/utils/auth.ts`

- `verifyJWT(token, secret)` — HS256 / Web Crypto API，驗簽名 + exp
- `JWTError` — 獨立錯誤型別，caller 可 `instanceof` 區分 401 vs 500

---

### Step 5 — 配對大廳 ✅
**檔案：** `src/api/lobby.ts`

- `LobbyDO` — 全域單一實例（`idFromName("main")`）序列化入口，天然防 Race Condition
- 長輪詢（Long-poll）：HTTP 連線掛起直到湊齊 4 人或 30 秒逾時
- `deadlines.set()` 在第一個 await 之前 — 關閉 re-entrancy 視窗
- 先 evict pending 再 await D1 — 防雙重配對
- 失敗還原：D1 insert 失敗時玩家回隊，不靜默丟失
- `MATCH_KV`：配對成功後寫入 `room:${playerId}` (TTL 1h)，閘道層快速擋重複請求
- `handleMatch(request, env)` — 供 `src/index.ts` 的 `/api/match` 路由呼叫

---

### Step 6 — 前端 SDK ✅
**檔案：** `src/client/GameSocket.ts`

- 指數退避重連：`delay = clamp(base × 2^attempt, max) × (1 ± jitter)`
- 重連後自動發送 `{ type:"sync" }` 取得最新 `GameStateView`
- `seq` 跨重連持續遞增（不重置），符合伺服器 anti-replay 驗證
- `disconnect()` 完整清理：clearTimeout → `ws.on* = null` → `ws.close()` → `registry.clear()`
- `on(event, handler)` 回傳 unsubscribe fn（React `useEffect` / Vue `onUnmounted` 友善）
- 型別安全：`send()` 接受 `PlayerAction`；`ServerMessage` exhaustive switch

---

### Step 7 — Gateway Worker ⬜
**檔案：** `src/workers/gateway.ts`

待實作項目：
- `POST /rooms` — 建立新房間（呼叫 GameRoomDO `/init`），回傳 `gameId`
- `POST /api/match` — 轉發至 `handleMatch(request, env)`
- `GET /rooms/:gameId/join` — 驗證 JWT → 升級 WebSocket → 轉發至對應 GameRoomDO
- 錯誤回應：房間不存在 / 滿員 / 未授權

---

### Step 8 — D1 Schema ⬜
**檔案：** `src/db/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS GameRooms (
  room_id       TEXT    PRIMARY KEY,
  player_ids    TEXT    NOT NULL,   -- JSON array
  status        TEXT    NOT NULL DEFAULT 'waiting',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  game_id       TEXT    PRIMARY KEY,
  round_id      TEXT    NOT NULL,
  finished_at   INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  winner_id     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS player_settlements (
  game_id        TEXT    NOT NULL,
  player_id      TEXT    NOT NULL,
  final_rank     INTEGER NOT NULL,
  score_delta    INTEGER NOT NULL,
  remaining_json TEXT    NOT NULL,
  PRIMARY KEY (game_id, player_id),
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);
```

---

### Step 9 — Queue Consumer ⬜
**檔案：** `src/workers/settlementConsumer.ts`

待實作項目：
- 實作 `queue()` handler，消費 `SettlementQueueMessage`
- 將 `SettlementResult` 寫入 D1（`games` + `player_settlements`）
- 失敗時 `message.retry()`，避免資料遺失

---

### Step 10 — Worker 主入口 ⬜
**檔案：** `src/index.ts`

待實作項目：
- 路由表：`POST /api/match` → `handleMatch`、`GET /rooms/:id/join` → GameRoomDO
- Export `GameRoomDO`、`LobbyDO` 供 wrangler 識別
- Export `queue()` handler 供 Queue Consumer 綁定

---

### Step 11 — wrangler.toml ⬜
**檔案：** `wrangler.toml`

```toml
name = "big-two-game"
main = "src/index.ts"
compatibility_date = "2024-09-23"

[[durable_objects.bindings]]
name       = "GAME_ROOM"
class_name = "GameRoomDO"

[[durable_objects.bindings]]
name       = "LOBBY_DO"
class_name = "LobbyDO"

[[queues.producers]]
binding = "SETTLEMENT_QUEUE"
queue   = "big-two-settlement"

[[queues.consumers]]
queue         = "big-two-settlement"
max_batch_size = 10

[[kv_namespaces]]
binding = "MATCH_KV"
id      = "<your-kv-id>"

[[d1_databases]]
binding       = "DB"
database_name = "big-two-db"
database_id   = "<your-d1-id>"
```

---

## 資料流總覽

```
Client (Browser / RN / Flutter)
  │
  │  POST /api/match (JWT)
  ▼
src/index.ts ──► handleMatch() ──► LobbyDO (idFromName "main")
                                        │  long-poll，湊齊 4 人
                                        ├─ INSERT GameRooms (D1)
                                        └─ Response { roomId, players }
  │
  │  WebSocket GET /rooms/:gameId/join
  ▼
gateway.ts ──upgrade──► GameRoomDO
                              │
                              ├─ BigTwoStateMachine.processAction()
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
