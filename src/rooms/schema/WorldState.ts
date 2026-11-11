import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), for the others' racer heads
    racing: t.boolean().default(false), // in a race right now (`race` message)
    distance: t.float64().default(0), // this race's distance so far, studs
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar`): what the others draw in the world.
    x: t.float64().default(0), // feet position in track coordinates (z minus the race scroll)
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing the gate)
    speed: t.float32().default(0), // m/s, for flames and dead reckoning
    boat: t.string().default(""), // equipped catalog ids (client config.js), "" = none / default
    engine: t.string().default(""),
    trail: t.string().default(""),
    partner: t.string().default(""),
    pets: t.string().default(""), // equipped pets "kind:tier,kind:tier"
    world: t.string().default(""), // the world the player is in (client WORLDS id), "" = the start world
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
    // Run a Farm (farms.ts): the farm slot around the town this player holds (0..FARM_SLOTS-1,
    // -1 = none) and the sanitized summary JSON of their farm (`farmInfo`), "" = not sent yet.
    slot: t.int8().default(-1),
    farm: t.string().default(""),
    // Bloxity integrations (presence.ts / bloxity.ts): the account id (verified on deployed servers;
    // "" = guest) so clients can match Bloxity chat messages to a player for the speech bubble,
    // what they ride ("" = on foot, else the client mount.js kind + "/" + seat), and the emote
    // playing ("" = none) with the server time it started.
    uid: t.string().default(""),
    ride: t.string().default(""),
    emote: t.string().default(""),
    emoteAt: t.float64().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
