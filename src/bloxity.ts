import { GUEST_ID_PREFIX, LB_BOARDS, LB_REPORT_MAX } from "./constants.js";

// Bloxity (Legion) platform calls the game server makes. Every one degrades to a no-op when the
// platform env vars are missing (local `npm start`), and none of them throws.
//   BLOXITY_API_URL      platform API base (injected by Legion hosting)
//   BLOXITY_GAME_ID      this game's id (= the client's GAME_SLUG)
//   BLOXITY_REPORT_TOKEN bearer token for the hosted leaderboard report
// Docs: https://docs.bloxity.io/#html5 (server token verification, hosted leaderboards).

const apiUrl = () => (process.env.BLOXITY_API_URL || "").replace(/\/$/, "");
const gameId = () => process.env.BLOXITY_GAME_ID || "run-a-farm";

// True when this server can verify Bloxity game tokens (deployed). Locally it can't, so the
// client-sent id is trusted there (dev only: never in production without the API URL).
export const canVerify = () => !!apiUrl();

export interface VerifiedUser {
  id: string; // the account id (user._id): the only id the server trusts
  username: string;
  pfp: string;
}

// POST {BLOXITY_API_URL}/v1/auth/game-token/verify -> { valid, user: { _id, username, displayName, pfp } }.
// null = not valid (a guest) or the check failed.
export async function verifyToken(token: unknown): Promise<VerifiedUser | null> {
  const base = apiUrl();
  if (!base || typeof token !== "string" || !token || token.length > 4096) return null;
  try {
    const res = await fetch(`${base}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ gameSlug: gameId() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { valid?: boolean; user?: { _id?: unknown; username?: unknown; displayName?: unknown; pfp?: unknown } };
    const id = body?.user?._id;
    if (!body?.valid || typeof id !== "string" || !id || id.startsWith(GUEST_ID_PREFIX)) return null;
    const name = body.user?.displayName || body.user?.username;
    return { id, username: typeof name === "string" ? name : "", pfp: typeof body.user?.pfp === "string" ? body.user.pfp : "" };
  } catch (err) {
    console.warn("[bloxity] token verify failed", err);
    return null;
  }
}

// --- Hosted leaderboards ----------------------------------------------------------------------------
// The boards (ids must match the client's bloxity.js LEADERBOARDS define()) are read from each
// signed-in player's saved farm, so the server reports from state it stores, not a client score.
export type Scores = Partial<Record<(typeof LB_BOARDS)[number]["id"], number>>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// The saved farm JSON (client game.js state) -> the board scores.
export function scoresFromFarm(farm: string | undefined): Scores {
  if (!farm) return {};
  try {
    const s = JSON.parse(farm) as Record<string, any>;
    return {
      level: num(s?.xp?.level),
      earned: num(s?.life?.earned),
      prestige: num(s?.prestige?.n),
      eggs: num(s?.life?.eggs),
    };
  } catch {
    return {};
  }
}

// A Bloxity account id as the report wants it: `legion_<id>`, without any `#m...` suffix; "" for
// anything that isn't an account.
export function reportId(id: string): string {
  const bare = id.split("#")[0];
  if (!bare || bare.startsWith(GUEST_ID_PREFIX)) return "";
  return bare.startsWith("legion_") ? bare : `legion_${bare}`;
}

// POST {BLOXITY_API_URL}/v1/leaderboards/hosted/{BLOXITY_GAME_ID}/report, at most LB_REPORT_MAX scores
// a call. Returns how many were accepted (0 when not configured).
export async function reportScores(rows: { userId: string; scores: Scores }[]): Promise<number> {
  const base = apiUrl();
  const token = process.env.BLOXITY_REPORT_TOKEN;
  if (!base || !token || !rows.length) return 0;
  const scores: { board: string; userId: string; score: number }[] = [];
  for (const r of rows) {
    const userId = reportId(r.userId);
    if (!userId) continue;
    for (const b of LB_BOARDS) {
      const score = r.scores[b.id];
      if (score) scores.push({ board: b.id, userId, score });
    }
  }
  let accepted = 0;
  for (let i = 0; i < scores.length; i += LB_REPORT_MAX) {
    try {
      const res = await fetch(`${base}/v1/leaderboards/hosted/${encodeURIComponent(gameId())}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ boards: LB_BOARDS, scores: scores.slice(i, i + LB_REPORT_MAX) }),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await res.json().catch((): null => null)) as { accepted?: number; dropped?: unknown } | null;
      accepted += body?.accepted ?? 0;
      if (body?.dropped) console.info("[bloxity] leaderboard report", { accepted: body.accepted, dropped: body.dropped });
    } catch (err) {
      console.warn("[bloxity] leaderboard report failed", err);
    }
  }
  return accepted;
}
