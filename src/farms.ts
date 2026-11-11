import { FARM_ID_MAX, FARM_INFO_MAX, FARM_LIST_MAX, FARM_PLOTS_MAX, FARM_SLOTS, ID_PATTERN } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// The four farms around the town. Every player in a room owns one farm slot (0..FARM_SLOTS-1);
// each client draws its own farm at home and the other slots around the town from the roster
// (`slot` + `farm`). A slot nobody holds is drawn as bare land.

// Lowest slot no other player in the room holds, or -1 when all are taken (the room is full).
export function freeSlot(taken: Iterable<number>): number {
  const used = new Set(taken);
  for (let s = 0; s < FARM_SLOTS; s++) if (!used.has(s)) return s;
  return -1;
}

const int = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && ID_PATTERN.test(s)).slice(0, FARM_LIST_MAX) : []);

// What the others draw of a player's farm: `farmInfo` { b: building ids, p: [[seed id | "", growth 0..100]]
// per owned field, s: stand level, tr / tk: tractors / trucks, d: drones, o: pump jacks, lv: farm level }.
// Bounded and re-encoded here, so the roster only ever carries this shape.
export interface FarmInfo {
  b: string[];
  p: [string, number][];
  s: number;
  tr: number;
  tk: number;
  d: number;
  o: number;
  lv: number;
}

export function sanitizeFarmInfo(msg: unknown): FarmInfo | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const plots: [string, number][] = [];
  if (Array.isArray(m.p)) {
    for (const row of m.p) {
      if (plots.length >= FARM_PLOTS_MAX) break;
      if (!Array.isArray(row)) continue;
      const seed = typeof row[0] === "string" && ID_PATTERN.test(row[0]) ? row[0] : "";
      plots.push([seed, int(row[1], 100)]);
    }
  }
  return { b: ids(m.b), p: plots, s: int(m.s, FARM_ID_MAX), tr: int(m.tr, FARM_ID_MAX), tk: int(m.tk, FARM_ID_MAX), d: int(m.d, FARM_ID_MAX), o: int(m.o, FARM_ID_MAX), lv: int(m.lv, 9999) };
}

// `farmInfo` { ...FarmInfo }: stores the sanitized summary as JSON on the roster (dropped when too long).
export function applyFarmInfo(p: PlayerState, msg: unknown): void {
  const info = sanitizeFarmInfo((msg as { farm?: unknown })?.farm ?? msg);
  if (!info) return;
  const json = JSON.stringify(info);
  if (json.length <= FARM_INFO_MAX) p.farm = json;
}
