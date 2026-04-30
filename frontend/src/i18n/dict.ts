// String dictionary for the two locales we ship: zh-TW (default) and en.
// Keep keys in dotted-domain form; add new keys at the bottom of each
// section to keep diffs small. Untranslated keys fall back to zh-TW.

export type Locale = "zh-TW" | "en";

export const LOCALES: Locale[] = ["zh-TW", "en"];

export const LOCALE_LABEL: Record<Locale, string> = {
  "zh-TW": "繁中",
  "en":    "EN",
};

const ZH = {
  // shared
  "common.back":           "返回",
  "common.cancel":         "取消",
  "common.close":          "關閉",
  "common.retry":          "重試",
  "common.loading":        "載入中…",
  "common.error":          "載入失敗",

  // login
  "login.title":           "Chiyigo 桌遊",
  "login.subtitle":        "三遊戲線上對戰",
  "login.placeholder":     "輸入暱稱",
  "login.submit":          "開始遊戲",
  "login.connecting":      "連線中…",
  "login.fail":            "連線失敗",
  "login.frozen":          "🔒 帳號已封鎖",
  "login.frozenReason":    "原因：{r}",
  "login.frozenContact":   "如有疑問請聯繫管理員",
  "common.logout":         "登出",

  // select
  "select.title":          "選擇遊戲",
  "select.bigTwo":         "大老二",
  "select.mahjong":        "台灣 16 張麻將",
  "select.texas":          "德州撲克",
  "select.tag.bigTwo":     "四人鬥地主經典 · 含 Bot 補位",
  "select.tag.mahjong":    "16 張台式 · 吃碰槓胡",
  "select.tag.texas":      "無限注德撲 · 邊池結算",
  "select.minAnte":        "最低 {n} 籌碼",
  "select.dailyBonus":     "🎁 每日登入獎勵 +{n} 籌碼",
  "select.stats":          "📊 統計",

  // lobby
  "lobby.matching":        "配對中",
  "lobby.cancel":          "取消",

  // wallet / stats
  "stats.tab.leaderboard": "🏆 排行榜",
  "stats.tab.history":     "📋 戰績",
  "stats.history.empty":   "尚無對戰紀錄",
  "stats.history.games":   "場數",
  "stats.history.winPct":  "勝率",
  "stats.history.net":     "淨分",
  "wallet.balance":        "餘額",
  "wallet.empty":          "尚無流水紀錄",
  "wallet.bailout":        "🆘 領取救濟金（餘額 < {n}，每 24h 一次）",
  "wallet.bailoutLoading": "領取中…",

  // result
  "result.win":            "你贏了！🎉",
  "result.end":            "遊戲結束",
  "result.again":          "再來一局",
  "result.fanDetail":      "台數明細",

  // pwa
  "pwa.offline":           "📡 離線中 — 連線恢復後會自動重連",
  "pwa.install":           "📲 安裝到主畫面",

  // big two game
  "bt.cardsLeft":          "手牌 {n} 張",
  "bt.yourTurn":           "輪到你了 · {n}s",
  "bt.theirTurn":          "{p} 的回合 · {n}s",
  "bt.newRound":           "— 新一輪 —",
  "bt.passN":              "PASS ×{n}",
  "bt.play":               "出牌",
  "bt.pass":               "PASS",
  "bt.combo.pair":         "對子",
  "bt.combo.straight":     "順子",
  "bt.combo.fullHouse":    "葫蘆",
  "bt.combo.fourOfAKind":  "鐵支",
  "bt.combo.straightFlush":"同花順",
  "bt.combo.tooltip":      "{label}（{n} 組可選；按 {key} 或重複點擊循環）",
  "bt.combo.disabled":     "沒有可用的{label}",
  "bt.combo.empty":        "—",
  "bt.combo.cycle":        "{cur}/{total}",
  "bt.combo.count":        "{n} 組",

  // mahjong
  "mj.handCount":          "手牌 {n}",
  "mj.wallRemaining":      "牌牆剩餘 {n} · {phase}",
  "mj.discardedBy":        "{p} 打出",
  "mj.noDiscard":          "尚無打牌",
  "mj.yourTurnToDiscard":  "輪到你打牌",
  "mj.canReact":           "可吃碰槓胡 · {n}s",
  "mj.theirTurn":          "{p} 行動中",
  "mj.discard":            "打牌",
  "mj.chow":               "吃",
  "mj.chowN":              "吃 ({n})",
  "mj.pong":               "碰",
  "mj.kong":               "明槓",
  "mj.ankan":              "暗槓",
  "mj.kakan":              "加槓",
  "mj.hu":                 "胡",
  "mj.tsumo":              "自摸",
  "mj.pass":               "過",
  "mj.pickChow":           "選擇吃牌組合",
  "mj.flowers":            "花牌",

  // texas
  "tx.opFolded":           "棄",
  "tx.opAllIn":            "All-in",
  "tx.pot":                "底池 {n} · {street}",
  "tx.mainPot":            "主池",
  "tx.sidePot":            "邊池 {n}",
  "tx.eligible":           "{n} 人爭奪",
  "tx.yourTurn":           "輪到你 · 需跟 {n}",
  "tx.theirTurn":          "{p} 行動中",
  "tx.chips":              "籌碼 {n}",
  "tx.thisStreet":         "本街下 {n}",
  "tx.fold":               "棄牌",
  "tx.check":              "過牌",
  "tx.call":               "跟注 {n}",
  "tx.raiseTo":            "加注 → {n}",
  "tx.allIn":              "All-in",
  "tx.minRaise":           "最低 {n}",
  "tx.potTimes":           "底池 ×{n}",
  "tx.maxRaise":           "最高 {n}",

  // result
  "result.firstPlace":     "🥇 第一",
  "result.secondPlace":    "🥈 第二",
  "result.thirdPlace":     "🥉 第三",
  "result.fourthPlace":    "第四",
  "result.delta":          "{n} 分",
  "result.fanLine":        "底 {base} · {fan} 台",
} as const;

export type DictKey = keyof typeof ZH;

const EN: Partial<Record<DictKey, string>> = {
  "common.back":            "Back",
  "common.cancel":          "Cancel",
  "common.close":           "Close",
  "common.retry":           "Retry",
  "common.loading":         "Loading…",
  "common.error":           "Failed to load",

  "login.title":            "Chiyigo Tabletop",
  "login.subtitle":         "Three-game online play",
  "login.placeholder":      "Enter your nickname",
  "login.submit":           "Start",
  "login.connecting":       "Connecting…",
  "login.fail":             "Connection failed",
  "login.frozen":           "🔒 Account suspended",
  "login.frozenReason":     "Reason: {r}",
  "login.frozenContact":    "Contact an administrator for details",
  "common.logout":          "Log out",

  "select.title":           "Pick a game",
  "select.bigTwo":          "Big Two",
  "select.mahjong":         "Taiwanese Mahjong",
  "select.texas":           "Texas Hold'em",
  "select.tag.bigTwo":      "4-player classic · with bot fill-in",
  "select.tag.mahjong":     "16-tile Taiwanese · chow / pong / kong / hu",
  "select.tag.texas":       "No-limit Hold'em · side pots",
  "select.minAnte":         "Min {n} chips",
  "select.dailyBonus":      "🎁 Daily login bonus +{n} chips",
  "select.stats":           "📊 Stats",

  "lobby.matching":         "Matching",
  "lobby.cancel":           "Cancel",

  "stats.tab.leaderboard":  "🏆 Leaderboard",
  "stats.tab.history":      "📋 History",
  "stats.history.empty":    "No games yet",
  "stats.history.games":    "Games",
  "stats.history.winPct":   "Win %",
  "stats.history.net":      "Net",
  "wallet.balance":         "Balance",
  "wallet.empty":           "No ledger entries",
  "wallet.bailout":         "🆘 Claim relief (balance < {n}, once per 24h)",
  "wallet.bailoutLoading":  "Claiming…",

  "result.win":             "You won! 🎉",
  "result.end":             "Game over",
  "result.again":           "Play again",
  "result.fanDetail":       "Hand breakdown",

  "pwa.offline":            "📡 Offline — will reconnect automatically",
  "pwa.install":            "📲 Install to home screen",

  "bt.cardsLeft":           "{n} cards",
  "bt.yourTurn":            "Your turn · {n}s",
  "bt.theirTurn":           "{p}'s turn · {n}s",
  "bt.newRound":            "— new round —",
  "bt.passN":               "PASS ×{n}",
  "bt.play":                "Play",
  "bt.pass":                "PASS",
  "bt.combo.pair":          "Pair",
  "bt.combo.straight":      "Straight",
  "bt.combo.fullHouse":     "Full house",
  "bt.combo.fourOfAKind":   "Four of a kind",
  "bt.combo.straightFlush": "Straight flush",
  "bt.combo.tooltip":       "{label} ({n} options; press {key} or click again to cycle)",
  "bt.combo.disabled":      "No {label} available",
  "bt.combo.empty":         "—",
  "bt.combo.cycle":         "{cur}/{total}",
  "bt.combo.count":         "{n} options",

  "mj.handCount":           "Hand {n}",
  "mj.wallRemaining":       "Wall {n} · {phase}",
  "mj.discardedBy":         "{p} discarded",
  "mj.noDiscard":           "No discard yet",
  "mj.yourTurnToDiscard":   "Your turn — discard",
  "mj.canReact":            "React (chow/pong/kong/hu) · {n}s",
  "mj.theirTurn":           "{p}'s turn",
  "mj.discard":             "Discard",
  "mj.chow":                "Chow",
  "mj.chowN":               "Chow ({n})",
  "mj.pong":                "Pong",
  "mj.kong":                "Kong",
  "mj.ankan":               "Concealed kong",
  "mj.kakan":               "Added kong",
  "mj.hu":                  "Hu",
  "mj.tsumo":               "Tsumo",
  "mj.pass":                "Pass",
  "mj.pickChow":            "Pick a chow combination",
  "mj.flowers":             "Flowers",

  "tx.opFolded":            "fold",
  "tx.opAllIn":             "All-in",
  "tx.pot":                 "Pot {n} · {street}",
  "tx.mainPot":             "Main",
  "tx.sidePot":             "Side {n}",
  "tx.eligible":            "{n} eligible",
  "tx.yourTurn":            "Your turn · owe {n}",
  "tx.theirTurn":           "{p}'s turn",
  "tx.chips":               "Stack {n}",
  "tx.thisStreet":          "Bet this street {n}",
  "tx.fold":                "Fold",
  "tx.check":               "Check",
  "tx.call":                "Call {n}",
  "tx.raiseTo":             "Raise → {n}",
  "tx.allIn":               "All-in",
  "tx.minRaise":            "Min {n}",
  "tx.potTimes":            "Pot ×{n}",
  "tx.maxRaise":            "Max {n}",

  "result.firstPlace":      "🥇 1st",
  "result.secondPlace":     "🥈 2nd",
  "result.thirdPlace":      "🥉 3rd",
  "result.fourthPlace":     "4th",
  "result.delta":           "{n} pts",
  "result.fanLine":         "Base {base} · {fan} fan",
};

const DICTS: Record<Locale, Partial<Record<DictKey, string>>> = {
  "zh-TW": ZH,
  "en":    EN,
};

/** Pluck a string. Falls back to zh-TW, then to the key name. */
export function tr(locale: Locale, key: DictKey, vars?: Record<string, string | number>): string {
  let s = DICTS[locale]?.[key] ?? ZH[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}
