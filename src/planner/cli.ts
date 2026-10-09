/**
 * Eyeball the planner: npx tsx src/planner/cli.ts iron_pickaxe 1 --inv oak_log=3
 *   goals:   item count [item count ...]   (or item:count)
 *   --inv    a=1,b=2        inventory
 *   --near   a=10,b=20      nearby blocks (name=nearest distance); default: oak_log=6,stone=10
 *   --stations table,furnace  stations already placed nearby
 *   --chest  a=1,b=2        one known chest holding these
 *   --creative              creative game mode
 *   --json                  print raw Plan JSON
 */
import { plan } from "./plan.js";
import type { Goal, WorldView } from "./types.js";

function kv(s: string | undefined): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of (s ?? "").split(",").filter(Boolean)) {
    const [k, v] = p.split("=");
    if (k) o[k] = Number(v ?? 1);
  }
  return o;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "";
};
const json = flag("json") !== undefined;
const creative = flag("creative") !== undefined;
const inv = kv(flag("inv"));
const nearRaw = flag("near");
const near = nearRaw === undefined ? { oak_log: 6, stone: 10 } : kv(nearRaw);
const stationsRaw = flag("stations") ?? "";
const chest = kv(flag("chest"));

const goals: Goal[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.includes(":")) {
    const [item, n] = a.split(":");
    goals.push({ item: item!, count: Number(n) || 1 });
  } else {
    const n = Number(argv[i + 1]);
    goals.push({ item: a, count: Number.isFinite(n) && argv[i + 1] !== undefined ? n : 1 });
    if (Number.isFinite(n) && argv[i + 1] !== undefined) i++;
  }
}
if (goals.length === 0) {
  console.error("usage: tsx src/planner/cli.ts <item> [count] ... [--inv a=1] [--near a=10] [--stations table,furnace] [--chest a=1] [--creative] [--json]");
  process.exit(2);
}

const view: WorldView = {
  inventory: inv,
  gameMode: creative ? "creative" : "survival",
  nearbyBlocks: Object.fromEntries(Object.entries(near).map(([k, d]) => [k, { count: 10, nearest: d }])),
  stations: { crafting_table: stationsRaw.includes("table"), furnace: stationsRaw.includes("furnace") },
  containers: Object.keys(chest).length ? [{ pos: { x: 10, y: 64, z: 10 }, items: chest }] : [],
  position: { x: 0, y: 64, z: 0 },
  dimension: "overworld",
};

const p = plan(goals, view);
if (json) {
  console.log(JSON.stringify(p, null, 2));
} else {
  console.log(`summary: ${p.summary}\n`);
  p.steps.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${JSON.stringify(s)}`));
  console.log(`\nrawNeeds: ${JSON.stringify(p.rawNeeds)}`);
  if (p.unresolved.length) console.log(`unresolved: ${JSON.stringify(p.unresolved)}`);
}
