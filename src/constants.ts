// Keep in step with the client's src/config.js by hand.
// Run a Farm: one room = one rural town with FARM_SLOTS farms around it, one per player.
export const FARM_SLOTS = 4;
export const ROOM_MAX_CLIENTS = FARM_SLOTS;
// Farm summary (farms.ts, roster `farm`): building ids / fields listed at most, the largest small
// count (stand level, tractors, trucks, drones, pump jacks) and the JSON length relayed.
export const FARM_LIST_MAX = 64;
export const FARM_PLOTS_MAX = 16;
export const FARM_ID_MAX = 64;
export const FARM_INFO_MAX = 2048;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, the most pets
// drawn per player, and the pose bounds (|x|, |y| and z up to `xy` m; z down to -`z` m: a race's
// track runs far down -Z; speed in m/s).
export const AVATAR_MAX_LEN = 3000;
export const PRESENCE_PETS_MAX = 8;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 512 * 1024;

// Run a Farm: the client's whole game state is saved as one JSON string (`farm`), opaque to the
// server beyond "a JSON object no longer than this" (must stay under MAX_PAYLOAD_BYTES).
export const FARM_MAX_LEN = 400 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules: the dearest engine costs ~3.6e28 Wins (client ENGINE gems).
export const CURRENCY_MAX = 1e33; // trophies (Wins), gems, lightning (energy)
export const REBIRTHS_MAX = 1e9;
export const DISTANCE_MAX = 1e15; // personal best race distance, studs
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year

// Owned catalog ids (client BOATS.list ~20, ENGINE ~34, PARTNER ~20, TRAILS ~29), with slack.
export const OWNED_MAX = 256;
// Pets (client PETS): at most PETS_MAX owned, PET_TIERS_MAX craft tiers, slots / storage the
// counters can grow to.
export const PETS_MAX = 1000;
export const PET_TIERS_MAX = 16;
export const PET_SLOTS_MAX = 50;
// Online Gifts (client GIFTS.list, 12 of them): claimed indexes and potion counts.
export const GIFTS_MAX = 64;
export const POTION_KINDS_MAX = 32;
export const POTION_COUNT_MAX = 1e9;
// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;

// Spin wheel (client SPIN in config.js; spin.ts): one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count.
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %). Ids match the client's SPIN.wedges; the client
// decides what each prize is, the server only which one is won.
export const SPIN_WEDGES = [
  { id: "doubleWins", weight: 35 },
  { id: "wins50", weight: 25 },
  { id: "luck", weight: 35 },
  { id: "wins250", weight: 4.9 },
  { id: "hugePet", weight: 0.1 },
] as const;

// Leaderboards (leaderboard.ts; client plaza.js boards): the saved doc fields ranked (Rebirth,
// Wins, Power, Playtime), rows per board and how often the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["rebirths", "trophies", "energy", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (boats, engines incl. `ladder-N`, partners, trails, pet kinds,
// potions): camelCase slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";

// --- Bloxity integrations (bloxity.ts, presence.ts) -------------------------------------------------
// Hosted leaderboards: the boards the server reports from each saved farm (client bloxity.js
// LEADERBOARDS must declare the same ids), how many scores per report call and how often.
export const LB_BOARDS = [
  { id: "level", label: "Farm Level", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "earned", label: "Money Earned", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "prestige", label: "Prestige", order: "desc", mode: "best", format: "number", reset: "none" },
  { id: "eggs", label: "Eggs Collected", order: "desc", mode: "best", format: "compact", reset: "none" },
] as const;
export const LB_REPORT_MAX = 200;
export const LB_REPORT_EVERY_MS = 30 * 1000;
// What a player rides (roster `ride`, client mount.js kinds; "" = on foot) and the emote they play
// (roster `emote`: a Bloxity emote catalogue id, `emoteAt` = server ms it started; "" = none).
export const RIDE_PATTERN = /^[a-z0-9_-]{0,24}$/;
export const EMOTE_PATTERN = /^[A-Za-z0-9_-]{0,48}$/;

// Invites (invite.ts): unlock the client's Money Boost (an invite sent) and Friends Boost (an
// invited friend joined). The most direct invites remembered, the friends-joined ceiling, and the
// shape of a Bloxity account id (invite targets / link `ref`).
export const INVITES_SENT_MAX = 200;
export const INVITES_MAX = 1e6;
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
