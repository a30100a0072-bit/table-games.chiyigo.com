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
