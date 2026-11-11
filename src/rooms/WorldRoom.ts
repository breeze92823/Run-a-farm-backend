import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { DISTANCE_MAX, GUEST_ID_PREFIX, LB_REPORT_EVERY_MS, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, type DailyState } from "../daily.js";
import { applyAvatar, applyEmote, applyLoadout, applyPose, applyRide } from "../presence.js";
import { inviteView, isUserId, readInvite, rememberSent, type InviteState } from "../invite.js";
import type { Filter } from "mongodb";
import { canVerify, reportScores, scoresFromFarm, verifyToken, type Scores } from "../bloxity.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { applyFarmInfo, freeSlot } from "../farms.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();
  // sessionId -> the latest farm JSON saved (or loaded) for its account, for the hosted
  // leaderboard report (bloxity.ts); and per account the scores last reported.
  private farms = new Map<string, string>();
  private reported = new Map<string, string>();
  // sessionId -> invite state (invite.ts), read with a signed-in player's save; and the inviter's
  // account id from the join options (`ref`: the invite link's tag), kept so a guest who signs in
  // mid-session is still credited to them.
  private inviteStates = new Map<string, InviteState>();
  private refs = new Map<string, string>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The personal best only ever goes up ($max), so a stale or replayed save can't lower it.
      const { bestDistance, ...rest } = patch;
      if (patch.farm) this.farms.set(client.sessionId, patch.farm);
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(bestDistance !== undefined && { $max: { bestDistance } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Claims Daily Reward day `msg.day` (0-based). The server decides: answers `dailyResult`
    // { ok, day, ...state }; the client only grants the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // The sender's race, relayed through the roster so everyone draws them on the distance bar and
    // podium: { racing, distance (studs this race) }, a few times a second while racing.
    race: (client: Client, msg: { racing?: unknown; distance?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.racing = msg?.racing === true;
      const d = msg?.distance;
      p.distance = p.racing && typeof d === "number" && Number.isFinite(d) ? Math.min(DISTANCE_MAX, Math.max(0, d)) : 0;
    },
    // Presence (presence.ts): the sender's pose ~10x/s, its equipped gear and its Bloxity look,
    // relayed through the roster so everyone draws them in the world (client remotePlayers.js).
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // What the sender rides now ({ kind, seat }, kind "" = on foot) and the Bloxity emote it
    // started ({ id }, "" = stopped), relayed through the roster (presence.ts).
    ride: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyRide(p, msg);
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // Run a Farm (farms.ts): a summary of the sender's farm, drawn by the others at its slot.
    farmInfo: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyFarmInfo(p, msg);
    },
    // Invites (invite.ts; they unlock the client's boosts). `invited` { friendId }: the client sent
    // a direct Bloxity invite; remembered so that friend counts when they join, and it unlocks the
    // Money Boost. `inviteLink`: the client shared its invite link (Money Boost too). Both answer
    // `invite`. `inviteRefresh` re-reads the friends-joined count (credited in another room / pod).
    invited: async (client: Client, msg: { friendId?: unknown }) => {
      const s = this.inviteStates.get(client.sessionId);
      const friendId = msg?.friendId;
      if (!s || !isUserId(friendId) || friendId === this.userIds.get(client.sessionId)) return;
      if (rememberSent(s, friendId)) await this.saveInvite(client.sessionId, { invitesSent: [...s.sent] });
      if (this.inviteStates.get(client.sessionId) === s) client.send("invite", inviteView(s));
    },
    inviteLink: async (client: Client) => {
      const s = this.inviteStates.get(client.sessionId);
      if (!s) return;
      if (!s.linkShared) {
        s.linkShared = true;
        await this.saveInvite(client.sessionId, { linkShared: true });
      }
      if (this.inviteStates.get(client.sessionId) === s) client.send("invite", inviteView(s));
    },
    inviteRefresh: async (client: Client) => {
      const s = this.inviteStates.get(client.sessionId);
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (!s) return client.send("invite", { ...inviteView(readInvite(null)), guest: !userId });
      if (userId && players) {
        try {
          s.joined = readInvite(await players.findOne({ _id: userId })).joined;
        } catch (err) {
          console.warn("[WorldRoom] inviteRefresh failed", err);
        }
      }
      if (this.inviteStates.get(client.sessionId) === s) client.send("invite", inviteView(s));
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string; pfp?: string; token?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (canVerify() || typeof msg?.userId === "string") void this.identifyFrom(client, p, msg);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    // Bloxity hosted leaderboards: report the signed-in players' scores (read from their saved
    // farm) every LB_REPORT_EVERY_MS, only the ones that changed.
    this.clock.setInterval((): void => void this.reportBoards(), LB_REPORT_EVERY_MS);
  }

  onDispose() {
    return this.reportBoards();
  }

  // Reports the given sessions' (default: everyone's) changed scores to Bloxity.
  private async reportBoards(sessionIds?: string[]) {
    const rows: { userId: string; scores: Scores }[] = [];
    for (const sid of sessionIds ?? [...this.farms.keys()]) {
      const userId = this.userIds.get(sid);
      const farm = this.farms.get(sid);
      if (!userId || !farm) continue;
      const scores = scoresFromFarm(farm);
      const key = JSON.stringify(scores);
      if (this.reported.get(userId) === key) continue;
      this.reported.set(userId, key);
      rows.push({ userId, scores });
    }
    if (rows.length) await reportScores(rows);
  }

  // The account behind a join / identify. Deployed (BLOXITY_API_URL set) only a verified Bloxity
  // game token counts, and a client-sent userId is ignored (Bloxity rule); a failed check plays as
  // a guest. Locally there is nothing to verify against, so the client's id is used (dev only).
  private async identifyFrom(client: Client, p: PlayerState, opts: { userId?: unknown; token?: unknown; username?: unknown; pfp?: unknown } | undefined) {
    if (!canVerify()) return this.setUserId(client, p, typeof opts?.userId === "string" ? opts.userId : "");
    const user = await verifyToken(opts?.token);
    if (this.state.players.get(client.sessionId) !== p) return; // left meanwhile
    if (user) {
      if (user.username) p.username = sanitizeName(user.username);
      if (user.pfp && !p.pfp) p.pfp = sanitizePfp(user.pfp);
    }
    this.setUserId(client, p, user?.id ?? "");
  }

  // `leaderboard` { boards: { rebirths|trophies|energy|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; token?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string; farm?: unknown; ride?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    // The lowest farm slot around the town nobody else holds (maxClients = FARM_SLOTS, so one is free).
    const taken: number[] = [];
    this.state.players.forEach((o) => taken.push(o.slot));
    p.slot = freeSlot(taken);
    if (options && typeof options === "object" && "farm" in options) applyFarmInfo(p, (options as { farm?: unknown }).farm);
    applyRide(p, options?.ride);
    const ref = (options as { ref?: unknown } | undefined)?.ref;
    if (isUserId(ref)) this.refs.set(client.sessionId, ref);
    this.state.players.set(client.sessionId, p);
    // Locally this answers at once; deployed it waits for the Bloxity token check.
    void this.identifyFrom(client, p, options);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    void this.reportBoards([sessionId]);
    this.farms.delete(sessionId);
    this.inviteStates.delete(sessionId);
    this.refs.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { spins: s.spins, spinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    this.inviteStates.delete(client.sessionId);
    p.signedIn = !!userId;
    p.uid = userId;
    this.farms.delete(client.sessionId);

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    if (doc?.farm) this.farms.set(client.sessionId, doc.farm);
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
    client.send("spins", this.spinView(spin, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", dailyView(daily));
    // Invites: signed-in players get their state (and may be credited as someone's invited
    // friend); a guest is told both boosts are locked.
    if (this.dailies.get(client.sessionId) !== daily) return;
    if (userId) {
      const invite = readInvite(doc);
      this.inviteStates.set(client.sessionId, invite);
      client.send("invite", inviteView(invite));
      void this.creditInvite(client, userId, invite, doc);
    } else client.send("invite", { ...inviteView(readInvite(null)), guest: true });
    void this.sendLeaderboard(client);
  }

  // Stores invite fields. True when stored, or when there is nowhere to store them (no database:
  // they live in `inviteStates` for the session).
  private async saveInvite(sessionId: string, fields: Partial<PlayerDoc>): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne({ _id: userId }, { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveInvite failed", err);
      return false;
    }
  }

  // A signed-in player joined who was never invited before: if their link's `ref` (or a direct
  // invite, `invitesSent`) names another existing player, they become that player's invited
  // friend. `invitedBy` is set once (a conditional write, so two rooms can't both credit), then the
  // inviter's `invites` goes up (live when the inviter is in this room: their Friends Boost unlocks).
  private async creditInvite(client: Client, userId: string, s: InviteState, doc: PlayerDoc | null) {
    const players = getPlayers();
    if (!players || doc?.invitedBy) return;
    try {
      const ref = this.refs.get(client.sessionId);
      let inviter = ref && ref !== userId ? await players.findOne({ _id: ref }) : null;
      if (!inviter) inviter = await players.findOne({ invitesSent: userId } as Filter<PlayerDoc>);
      if (!inviter || inviter._id === userId) return;
      let credited = false;
      try {
        const res = await players.updateOne(
          { _id: userId, invitedBy: { $exists: false } } as Filter<PlayerDoc>,
          { $set: { invitedBy: inviter._id }, $setOnInsert: { version: 1, updatedAt: new Date() } },
          { upsert: true },
        );
        credited = res.modifiedCount + (res.upsertedCount ?? 0) > 0;
      } catch {
        // Duplicate key: another session credited this account first.
      }
      if (!credited) return;
      await players.updateOne({ _id: inviter._id }, { $inc: { invites: 1 } });
      const name = this.state.players.get(client.sessionId)?.username || "A friend";
      if (this.inviteStates.get(client.sessionId) === s) client.send("invitedBy", { name: inviter.username || "A friend" });
      // The inviter, when online in this room.
      for (const [sid, uid] of this.userIds) {
        const is = this.inviteStates.get(sid);
        const c = this.clients.find((c) => c.sessionId === sid);
        if (uid !== inviter._id || !is || !c) continue;
        is.joined++;
        c.send("invite", inviteView(is));
        c.send("friendJoined", { name });
      }
    } catch (err) {
      console.warn("[WorldRoom] creditInvite failed", err);
    }
  }
}
