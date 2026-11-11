import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { FARM_PLOTS_MAX, FARM_SLOTS, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { freeSlot, sanitizeFarmInfo } from "../src/farms.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("farms around the town", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("one room holds one player per farm slot", () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, FARM_SLOTS);
    assert.strictEqual(freeSlot([]), 0);
    assert.strictEqual(freeSlot([0, 2]), 1);
    assert.strictEqual(freeSlot([0, 1, 2, 3]), -1);
  });

  it("gives every player the lowest free slot and reuses a slot when its player leaves", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    const b = await colyseus.connectTo(room, { userId: "guest-b", username: "Bo" });
    const c = await colyseus.connectTo(room, { userId: "guest-c", username: "Cy" });
    await sleep(50);
    assert.deepStrictEqual([a, b, c].map((x) => room.state.players.get(x.sessionId)!.slot), [0, 1, 2]);
    await b.leave(true);
    await sleep(50);
    const d = await colyseus.connectTo(room, { userId: "guest-d", username: "Di" });
    await sleep(50);
    assert.strictEqual(room.state.players.get(d.sessionId)!.slot, 1, "Bo's farm slot goes to the next player");
  });

  it("relays a bounded farm summary", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann", farm: { b: ["coop2"], s: 2 } });
    await sleep(50);
    const pa = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual(JSON.parse(pa.farm).b, ["coop2"], "the join options may carry the farm");

    const plots = Array.from({ length: 40 }, () => ["wheat", 250]);
    a.send("farmInfo", { farm: { b: ["storage", "bad id!", 7], p: plots, s: 3, tr: 2, tk: -4, d: 1e9, o: 2, lv: 12 } });
    await sleep(50);
    const f = JSON.parse(pa.farm);
    assert.deepStrictEqual(f.b, ["storage"]);
    assert.strictEqual(f.p.length, FARM_PLOTS_MAX);
    assert.deepStrictEqual(f.p[0], ["wheat", 100]);
    assert.strictEqual(f.tk, 0);
    assert.strictEqual(f.d, 64);
    assert.strictEqual(f.lv, 12);
  });

  it("drops anything that is not a summary", () => {
    assert.strictEqual(sanitizeFarmInfo(null), null);
    assert.strictEqual(sanitizeFarmInfo("farm"), null);
    assert.deepStrictEqual(sanitizeFarmInfo({ p: [["<script>", 50], "x"] })!.p, [["", 50]]);
  });
});
