/** Side-by-side comparison of two eval run dirs: `npm run eval:compare -- <runDirA> <runDirB>`. */
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.js";
import { aggregateResults, groupBy, loadResults, median, totalIn, type Agg } from "./report.js";
import type { ScenarioResult } from "./types.js";

const sec = (ms: number | null) => (ms === null ? "-" : (ms / 1000).toFixed(1));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const delta = (a: number | null, b: number | null, f: (n: number) => string, lowerBetter = true): string => {
  if (a === null || b === null) return "-";
  const d = b - a;
  if (Math.abs(d) < 1e-9) return "=";
  const good = lowerBetter ? d < 0 : d > 0;
  return `${d > 0 ? "+" : "-"}${f(Math.abs(d))}${good ? " ✓" : " ✗"}`;
};

function perScenario(rs: ScenarioResult[]) {
  return {
    n: rs.length,
    ok: rs.filter((r) => r.ok).length / rs.length,
    score: rs.reduce((a, r) => a + r.score, 0) / rs.length,
    wall: median(rs.map((r) => r.wallMs)),
    turns: rs.reduce((a, r) => a + r.turns, 0) / rs.length,
    tokIn: rs.reduce((a, r) => a + totalIn(r), 0) / rs.length,
    cost: rs.reduce((a, r) => a + r.costUsd, 0) / rs.length,
  };
}

export function compareMarkdown(dirA: string, dirB: string): string {
  const A = loadResults(dirA);
  const B = loadResults(dirB);
  const ga = groupBy(A, (r) => r.id);
  const gb = groupBy(B, (r) => r.id);
  const ids = [...new Set([...ga.keys(), ...gb.keys()])].map(String).sort();
  const L: string[] = [`# Eval compare`, "", `A = ${dirA} (${A[0]?.label ?? "?"})`, `B = ${dirB} (${B[0]?.label ?? "?"})`, "", "Delta = B - A; ✓ means B is better.", ""];
  L.push("| scenario | success A | success B | score A→B | wall s A→B | turns A→B | cost A→B |", "|---|---|---|---|---|---|---|");
  for (const id of ids) {
    const a = ga.has(id) ? perScenario(ga.get(id)!) : null;
    const b = gb.has(id) ? perScenario(gb.get(id)!) : null;
    L.push(
      `| ${id} | ${a ? pct(a.ok) : "-"} | ${b ? pct(b.ok) : "-"} | ${a ? a.score.toFixed(2) : "-"}→${b ? b.score.toFixed(2) : "-"} ${delta(a?.score ?? null, b?.score ?? null, (n) => n.toFixed(2), false)} | ${sec(a?.wall ?? null)}→${sec(b?.wall ?? null)} ${delta(a?.wall ?? null, b?.wall ?? null, (n) => sec(n))} | ${a ? a.turns.toFixed(1) : "-"}→${b ? b.turns.toFixed(1) : "-"} ${delta(a?.turns ?? null, b?.turns ?? null, (n) => n.toFixed(1))} | $${a ? a.cost.toFixed(3) : "-"}→$${b ? b.cost.toFixed(3) : "-"} ${delta(a?.cost ?? null, b?.cost ?? null, (n) => n.toFixed(3))} |`,
    );
  }
  L.push("", "## Per tier (ids present in both runs only)", "", "| tier | runs A/B | success A→B | median wall s A→B | turns A→B | tok in A→B | cost A→B |", "|---|---|---|---|---|---|---|");
  const both = new Set(ids.filter((i) => ga.has(i) && gb.has(i)));
  const rowFor = (name: string, a: Agg, b: Agg) =>
    `| ${name} | ${a.n}/${b.n} | ${pct(a.successRate)}→${pct(b.successRate)} ${delta(a.successRate, b.successRate, (n) => pct(n), false)} | ${sec(a.medianWallMs)}→${sec(b.medianWallMs)} ${delta(a.medianWallMs, b.medianWallMs, (n) => sec(n))} | ${a.turns}→${b.turns} ${delta(a.turns / a.n, b.turns / b.n, (n) => n.toFixed(1))} | ${k(a.inTokens)}→${k(b.inTokens)} | $${a.costUsd.toFixed(3)}→$${b.costUsd.toFixed(3)} ${delta(a.costUsd / a.n, b.costUsd / b.n, (n) => n.toFixed(3))} |`;
  const fa = A.filter((r) => both.has(r.id));
  const fb = B.filter((r) => both.has(r.id));
  const ta = groupBy(fa, (r) => r.tier);
  const tb = groupBy(fb, (r) => r.tier);
  for (const t of [...new Set([...ta.keys(), ...tb.keys()])].sort())
    if (ta.has(t) && tb.has(t)) L.push(rowFor(`T${t}`, aggregateResults(ta.get(t)!), aggregateResults(tb.get(t)!)));
  if (fa.length && fb.length) L.push(rowFor("**overall**", aggregateResults(fa), aggregateResults(fb)));
  L.push("", "(per-run turns/cost deltas are normalized per run so differing repeat counts compare fairly)");
  return L.join("\n") + "\n";
}

if (process.argv[1]?.endsWith("compare.ts")) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: npm run eval:compare -- <runDirA> <runDirB>");
    process.exit(2);
  }
  console.log(compareMarkdown(resolve(REPO_ROOT, a), resolve(REPO_ROOT, b)));
}
