// /src/routes/leaderboard.ts
// GET /api/leaderboard — top 20 by chip_balance. No auth (public board).
// Bots filtered via BOT_ prefix; settlement consumer never inserts BOT_*
// into users so this is mostly defence-in-depth.                       // L3_架構含防禦觀測

export interface LeaderboardEnv {
  DB: D1Database;
}

export async function getLeaderboard(env: LeaderboardEnv): Promise<Response> {
  const rows = await env.DB
    .prepare(
      "SELECT player_id, display_name, chip_balance" +
      " FROM users" +
      " WHERE player_id NOT LIKE 'BOT\\_%' ESCAPE '\\'" +
      " ORDER BY chip_balance DESC" +
      " LIMIT 20",
    )
    .all<{ player_id: string; display_name: string; chip_balance: number }>();

  return Response.json({
    updatedAt: Date.now(),
    rows: rows.results ?? [],
  });
}
