/** results.jsonl → markdown summary (shared by runner + compare). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./types.js";

export function loadResults(runDir: string): ScenarioResult[] {
  const p = join(runDir, "results.jsonl");
  if (!existsSync(p)) throw new Error(`${p} not found`);
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ScenarioResult);
}

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1));
const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
const usd = (x: number) => `$${x.toFixed(3)}`;
export const totalIn = (r: ScenarioResult) => r.inputTokens + r.cacheReadTokens + r.cacheCreateTokens;
const violTotal = (r: ScenarioResult) => r.violations.brokenProtected + r.violations.pillarRuns + r.violations.chatSpam + r.violations.deaths;
const violText = (r: ScenarioResult) => {
  const v = r.violations;
  const parts = [v.brokenProtected && `broke${v.brokenProtected}`, v.pillarRuns && `pillar${v.pillarRuns}`, v.chatSpam && `spam${v.chatSpam}`, v.deaths && `death${v.deaths}`].filter(Boolean);
  return parts.length ? parts.join(" ") : "-";
};

export interface Agg {
  n: number;
  successRate: number;
  meanScore: number;
  medianWallMs: number | null;
  turns: number;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  cacheHit: number | null;
  violations: number;
  harnessErrors: number;
}

export function aggregateResults(rs: ScenarioResult[]): Agg {
  const cr = sum(rs.map((r) => r.cacheReadTokens));
  const tin = sum(rs.map(totalIn));
  return {
    n: rs.length,
    successRate: rs.length ? rs.filter((r) => r.ok).length / rs.length : 0,
    meanScore: mean(rs.map((r) => r.score)) ?? 0,
    medianWallMs: median(rs.map((r) => r.wallMs)),
    turns: sum(rs.map((r) => r.turns)),
    inTokens: tin,
    outTokens: sum(rs.map((r) => r.outputTokens)),
    costUsd: sum(rs.map((r) => r.costUsd)),
    cacheHit: tin > 0 ? cr / tin : null,
    violations: sum(rs.map(violTotal)),
    harnessErrors: rs.filter((r) => r.harnessError).length,
  };
}

export function groupBy<T>(xs: T[], key: (x: T) => string | number): Map<string | number, T[]> {
  const m = new Map<string | number, T[]>();
  for (const x of xs) {
    const kk = key(x);
    m.set(kk, [...(m.get(kk) ?? []), x]);
  }
  return m;
}

export function summaryMarkdown(results: ScenarioResult[], title: string): string {
  const L: string[] = [`# Eval summary: ${title}`, ""];
  L.push("| scenario | rep | ok | score | wall s | reply s | tasks | turns | tok in | tok out | cache | cost | viol | note |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const note = r.harnessError ? `HARNESS: ${r.harnessError}` : r.timedOut ? `timeout; ${r.detail}` : r.detail;
    L.push(
      `| ${r.id} | ${r.repeat} | ${r.ok ? "PASS" : "FAIL"} | ${r.score.toFixed(2)} | ${sec(r.wallMs)} | ${sec(r.firstReplyMs)} | ${r.tasks} | ${r.turns} | ${k(totalIn(r))} | ${k(r.outputTokens)} | ${pct(r.cacheHitRate)} | ${usd(r.costUsd)} | ${violText(r)} | ${note.replace(/\|/g, "/").slice(0, 110)} |`,
    );
  }
  L.push("", "## Per tier", "", "| tier | runs | success | mean score | median wall s | turns | tok in | tok out | cache | cost | viol |", "|---|---|---|---|---|---|---|---|---|---|---|");
  const row = (name: string, a: Agg) =>
    `| ${name} | ${a.n} | ${pct(a.successRate)} | ${a.meanScore.toFixed(2)} | ${sec(a.medianWallMs)} | ${a.turns} | ${k(a.inTokens)} | ${k(a.outTokens)} | ${pct(a.cacheHit)} | ${usd(a.costUsd)} | ${a.violations} |`;
  const tiers = groupBy(results, (r) => r.tier);
  for (const t of [...tiers.keys()].sort()) L.push(row(`T${t}`, aggregateResults(tiers.get(t)!)));
  L.push(row("**overall**", aggregateResults(results)));
  const he = results.filter((r) => r.harnessError).length;
  if (he) L.push("", `WARNING: ${he} run(s) had harness errors (not attributable to the bot).`);
  return L.join("\n") + "\n";
}
