import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { reportId, reportScores, scoresFromFarm } from "../src/bloxity.js";
import { applyEmote, applyRide } from "../src/presence.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("bloxity integrations", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const realFetch = globalThis.fetch;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => {
    __setPlayersForTest(null);
    globalThis.fetch = realFetch;
    delete process.env.BLOXITY_API_URL;
    delete process.env.BLOXITY_REPORT_TOKEN;
  });

  it("reads the board scores from a saved farm and formats report ids", () => {
    const farm = JSON.stringify({ xp: { level: 7 }, life: { earned: 12345.6, eggs: 90 }, prestige: { n: 2 } });
    assert.deepStrictEqual(scoresFromFarm(farm), { level: 7, earned: 12345, prestige: 2, eggs: 90 });
    assert.deepStrictEqual(scoresFromFarm("nope"), {});
    assert.strictEqual(reportId("abc#m12"), "legion_abc");
    assert.strictEqual(reportId("legion_abc"), "legion_abc");
    assert.strictEqual(reportId("guest-1"), "");
  });

  it("bounds ride and emote", () => {
    const p: any = { ride: "", emote: "", emoteAt: 0 };
    applyRide(p, { kind: "tractor", seat: "seat" });
    assert.strictEqual(p.ride, "tractor/seat");
    applyRide(p, { kind: "<script>" });
    assert.strictEqual(p.ride, "");
    applyEmote(p, { id: "65f0c0ffee0123456789abcd" }, 1000);
    assert.deepStrictEqual([p.emote, p.emoteAt], ["65f0c0ffee0123456789abcd", 1000]);
    applyEmote(p, { id: "a b" }, 2000);
    assert.strictEqual(p.emoteAt, 1000, "a bad id is ignored");
    applyEmote(p, { id: "" }, 3000);
    assert.deepStrictEqual([p.emote, p.emoteAt], ["", 0]);
  });

  it("posts the hosted leaderboard report only when configured", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      if (!String(url).startsWith("https://api.example")) return realFetch(url, init);
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return new Response(JSON.stringify({ ok: true, accepted: 2 }));
    }) as any;
    assert.strictEqual(await reportScores([{ userId: "u1", scores: { level: 3 } }]), 0, "no env: no call");
    assert.strictEqual(calls.length, 0);
    process.env.BLOXITY_API_URL = "https://api.example";
    process.env.BLOXITY_REPORT_TOKEN = "tok";
    assert.strictEqual(await reportScores([{ userId: "u1", scores: { level: 3, eggs: 5 } }, { userId: "guest-x", scores: { level: 9 } }]), 2);
    assert.match(calls[0].url, /\/v1\/leaderboards\/hosted\/.+\/report$/);
    assert.strictEqual(calls[0].auth, "Bearer tok");
    assert.deepStrictEqual(calls[0].body.scores, [
      { board: "level", userId: "legion_u1", score: 3 },
      { board: "eggs", userId: "legion_u1", score: 5 },
    ]);
  });

  it("deployed, trusts only a verified token and ignores a client-sent userId", async () => {
    process.env.BLOXITY_API_URL = "https://api.example";
    globalThis.fetch = (async (url: string, init: any) => {
      if (!String(url).startsWith("https://api.example")) return realFetch(url, init);
      const ok = init.headers.Authorization === "Bearer good";
      return new Response(JSON.stringify(ok ? { valid: true, user: { _id: "acc1", displayName: "Real Name" } } : { valid: false }), { status: ok ? 200 : 401 });
    }) as any;
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "forged", token: "good", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "acc1", token: "bad" });
    for (const c of [a, b]) for (const t of ["progress", "noProgress", "spins", "daily", "leaderboard"]) c.onMessage(t, () => {});
    await sleep(200);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(pa.uid, "acc1");
    assert.strictEqual(pa.signedIn, true);
    assert.strictEqual(pa.username, "Real Name");
    assert.strictEqual(pb.uid, "", "a bad token is a guest, whatever userId it sent");
    assert.strictEqual(pb.signedIn, false);
  });

  it("relays ride and emote through the roster", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-r", ride: { kind: "bike", seat: "bike" } });
    for (const t of ["noProgress", "spins", "daily", "leaderboard"]) c.onMessage(t, () => {});
    await sleep(100);
    const p = room.state.players.get(c.sessionId)!;
    assert.strictEqual(p.ride, "bike/bike");
    c.send("ride", { kind: "" });
    c.send("emote", { id: "wave01" });
    await sleep(100);
    assert.strictEqual(p.ride, "");
    assert.strictEqual(p.emote, "wave01");
    assert.ok(p.emoteAt > 0);
  });
});
