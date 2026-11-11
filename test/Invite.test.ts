import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { inviteView, readInvite, rememberSent } from "../src/invite.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const doc = (id: string, f: Partial<PlayerDoc> = {}): PlayerDoc => ({ _id: id, version: 1, updatedAt: new Date(), ...f });
const quiet = (c: any) => {
  for (const t of ["progress", "noProgress", "spins", "daily", "leaderboard", "invitedBy", "friendJoined"]) c.onMessage(t, () => {});
};

describe("invites (boost unlocks)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("unlocks nothing until an invite is sent, and the Friends Boost only once a friend joined", () => {
    const s = readInvite(null);
    assert.deepStrictEqual(inviteView(s), { sent: false, joined: 0, moneyBoost: false, friendsBoost: false });
    assert.ok(rememberSent(s, "f1"));
    assert.ok(!rememberSent(s, "f1"), "the same friend twice in a row changes nothing");
    assert.deepStrictEqual(inviteView(s), { sent: true, joined: 0, moneyBoost: true, friendsBoost: false });
    assert.strictEqual(readInvite(doc("x", { invites: 2, invitesSent: ["a", "bad id!"] })).sent.length, 1);
    assert.strictEqual(inviteView(readInvite(doc("x", { linkShared: true }))).moneyBoost, true);
  });

  it("a direct invite unlocks the inviter's Money Boost and saves it; a guest is told it is locked", async () => {
    const fake = fakePlayers([doc("ann")]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ann", username: "Ann" });
    const views: any[] = [];
    quiet(a);
    a.onMessage("invite", (m: any) => views.push(m));
    fake.release();
    await sleep(150);
    assert.strictEqual(views[0]?.moneyBoost, false);
    a.send("invited", { friendId: "bob" });
    await sleep(150);
    assert.strictEqual(views[views.length - 1].moneyBoost, true);
    assert.deepStrictEqual(fake.docs.get("ann")?.invitesSent, ["bob"]);

    const g = await colyseus.connectTo(room, { userId: "guest-1" });
    let gv: any = null;
    quiet(g);
    g.onMessage("invite", (m: any) => (gv = m));
    g.send("inviteRefresh", {});
    await sleep(150);
    assert.deepStrictEqual([gv?.guest, gv?.moneyBoost, gv?.friendsBoost], [true, false, false]);
    g.send("inviteLink", {});
    await sleep(100);
    assert.strictEqual(gv.moneyBoost, false, "a guest can't unlock it");
  });

  it("credits the inviter when the invited friend joins (link ref or direct), once per account", async () => {
    const fake = fakePlayers([doc("ann", { username: "Ann", invitesSent: ["bob"] }), doc("cat", { username: "Cat" })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "ann", username: "Ann" });
    let av: any = null;
    let joinedName = "";
    quiet(a);
    a.onMessage("invite", (m: any) => (av = m));
    a.onMessage("friendJoined", (m: any) => (joinedName = m.name));
    fake.release();
    await sleep(150);
    assert.strictEqual(av.friendsBoost, false);

    // Bob was invited directly: joining (anywhere) credits Ann, live.
    const b = await colyseus.connectTo(room, { userId: "bob", username: "Bob" });
    quiet(b);
    b.onMessage("invite", () => {});
    await sleep(200);
    assert.strictEqual(av.friendsBoost, true);
    assert.strictEqual(av.joined, 1);
    assert.strictEqual(joinedName, "Bob");
    assert.strictEqual(fake.docs.get("bob")?.invitedBy, "ann");

    // Dan comes through Cat's link (`ref`); Bob rejoining doesn't count twice.
    await b.leave();
    const b2 = await colyseus.connectTo(room, { userId: "bob", ref: "cat" });
    const d = await colyseus.connectTo(room, { userId: "dan", ref: "cat" });
    for (const c of [b2, d]) {
      quiet(c);
      c.onMessage("invite", () => {});
    }
    await sleep(200);
    assert.strictEqual(fake.docs.get("ann")?.invites, 1);
    assert.strictEqual(fake.docs.get("cat")?.invites, 1);
    assert.strictEqual(fake.docs.get("dan")?.invitedBy, "cat");
  });
});
