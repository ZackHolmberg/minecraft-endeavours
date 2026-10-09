/**
 * Eval runner: `npm run eval -- --bot-dir <path> --label <name> [--only globs] [--repeat N] [--out dir] [--no-reset]`
 * See v2/EVAL.md. Runs scenarios sequentially against the isolated test server,
 * one fresh bot process per scenario, and writes results.jsonl + summary.md.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BotProcess, inspectBotDir, wipeBotState, type BotDirInfo } from "./bot-process.js";
import { EvalContext } from "./ctx.js";
import { REPO_ROOT, makeRcon, sleep, testServerEnv, type TestServerEnv } from "./env.js";
import type { Rcon } from "./rcon.js";
import { loadResults, summaryMarkdown } from "./report.js";
import { selectScenarios } from "./scenarios/index.js";
import { loadSites } from "./scout.js";
import { collectMetrics, readEvents, taskState } from "./telemetry.js";
import { Tester } from "./tester.js";
import { hasPristine, restorePristine } from "./world.js";
import type { CheckResult, Scenario, ScenarioResult, Vec3 } from "./types.js";

const POLL_MS = 5000;
const INFLIGHT_WAIT_MS = 60_000;
const BOT_JOIN_TIMEOUT_MS = 120_000;

interface Args {
  botDir: string;
  label: string;
  only?: string;
  repeat: number;
  out?: string;
  noReset: boolean;
  /** Debug: multiply every scenario timeout (e.g. 0.1 to exercise the timeout path). */
  timeoutScale: number;
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> & { noReset: boolean; repeat: number; timeoutScale: number } = { noReset: false, repeat: 1, timeoutScale: 1 };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const v = () => argv[++i] ?? "";
    if (f === "--bot-dir") a.botDir = v();
    else if (f === "--label") a.label = v();
    else if (f === "--only") a.only = v();
    else if (f === "--repeat") a.repeat = Math.max(1, Number(v()) || 1);
    else if (f === "--out") a.out = v();
    else if (f === "--no-reset") a.noReset = true;
    else if (f === "--timeout-scale") a.timeoutScale = Number(v()) || 1;
    else throw new Error(`unknown flag ${f}`);
  }
  if (!a.botDir || !a.label) throw new Error("usage: npm run eval -- --bot-dir <path> --label <name> [--only globs] [--repeat N] [--out dir] [--no-reset]");
  return a as Args;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

interface Harness {
  args: Args;
  info: BotDirInfo;
  env: TestServerEnv;
  rcon: Rcon;
  tester: Tester;
  out: string;
  sites: ReturnType<typeof loadSites>["sites"];
}

async function ensureConnections(h: Harness): Promise<void> {
  if (!h.rcon.connected) await h.rcon.connect();
  if (!h.tester.alive) await h.tester.connect();
  await h.rcon.command("gamemode creative Tester");
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function botOnline(h: Harness): Promise<boolean> {
  return (await h.rcon.command("list")).includes(h.info.username);
}

async function runScenario(h: Harness, sc: Scenario, repeat: number): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const key = `${sc.id}-${repeat}`;
  const tdir = join(h.out, "telemetry", key);
  rmSync(tdir, { recursive: true, force: true });
  const bp = new BotProcess(h.info, tdir, join(h.out, "logs", `${key}.log`));
  const ac = new AbortController();
  let ctx: EvalContext | null = null;
  let timedOut = false;
  let harnessError: string | undefined;
  let firstOkAt: number | null = null;
  let bestScore = 0;
  let last: CheckResult = { ok: false, detail: "never checked" };
  let runEndAt = Date.now();

  try {
    const site = h.sites[sc.site];
    if (!site) throw new Error(`site "${sc.site}" missing from sites.json`);
    await ensureConnections(h);
    const { rcon, tester } = h;
    const bot = h.info.username;

    // Fresh bot state + make sure no stale session is on the server.
    wipeBotState(h.info);
    if (await botOnline(h)) {
      await rcon.command(`kick ${bot}`);
      await waitFor(async () => !(await botOnline(h)), 15_000);
    }

    // Load the site in the Tester's world, then start the bot.
    await rcon.command(`tp Tester ${site.x} ${site.y + 6} ${site.z}`);
    if (!(await waitFor(() => tester.blockNameAt(site) !== null, 90_000))) throw new Error("site chunks did not load for the Tester");
    // Paper rejects same-IP logins within 4s of each other ("Connection throttled").
    await sleep(Math.max(0, tester.connectedAt + 5500 - Date.now()));
    bp.start();
    if (!(await waitFor(async () => (!bp.running ? true : await botOnline(h)), BOT_JOIN_TIMEOUT_MS, 1000)) || !(await botOnline(h)))
      throw new Error(bp.running ? "bot did not join within timeout (see log)" : "bot process exited during startup (see log)");
    await sleep(3000);

    // Standard reset.
    const mode = sc.gameMode ?? "survival";
    const sx = site.x + (sc.botStart?.x ?? 0);
    const sz = site.z + (sc.botStart?.z ?? 0);
    const sy = (tester.surfaceY(sx, sz) ?? site.y - 1) + 1 + (sc.botStart?.y ?? 0);
    for (const c of [
      `gamemode ${mode} ${bot}`,
      `clear ${bot}`,
      `effect clear ${bot}`,
      `effect give ${bot} minecraft:instant_health 1 10 true`,
      `effect give ${bot} minecraft:saturation 1 10 true`,
      `experience set ${bot} 0 levels`,
      `experience set ${bot} 0 points`,
      "weather clear",
      "time set 1000",
      "difficulty normal",
      `execute positioned ${site.x} ${site.y} ${site.z} run kill @e[type=!player,type=!minecraft:villager,type=!minecraft:iron_golem,distance=..64]`,
      `tp ${bot} ${sx + 0.5} ${sy} ${sz + 0.5}`,
      `tp Tester ${site.x + 4.5} ${(tester.surfaceY(site.x + 4, site.z) ?? site.y - 1) + 1} ${site.z + 0.5}`,
    ])
      await rcon.command(c);
    await sleep(1500);

    ctx = new EvalContext(bot, "Tester", site as Vec3, ac.signal, rcon, tester, bp.eventsPath);
    await sc.setup(ctx);
    await sleep(2000); // let setup's block updates drain before arming protection
    ctx.armed = true;
    tester.resetChats();

    // Run + early-success polling.
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, sc.timeoutMs * h.args.timeoutScale);
    let polling = false;
    const poll = async () => {
      if (polling || ac.signal.aborted) return;
      polling = true;
      try {
        const r = await sc.check(ctx!);
        last = r;
        bestScore = Math.max(bestScore, r.score ?? (r.ok ? 1 : 0));
        if (r.ok && firstOkAt === null) {
          firstOkAt = Date.now();
          ctx!.successFlag = true;
        }
      } catch {
        /* transient RCON/Tester hiccup; final check will surface real errors */
      } finally {
        polling = false;
      }
    };
    const pollTimer = setInterval(poll, POLL_MS);
    const aborted = new Promise<void>((res) => ac.signal.addEventListener("abort", () => res(), { once: true }));
    try {
      await Promise.race([sc.run(ctx), aborted]);
    } catch (e) {
      if (!ac.signal.aborted) harnessError = `run() threw: ${(e as Error).message}`;
    }
    clearTimeout(timer);
    clearInterval(pollTimer);
    await waitFor(() => !polling, 10_000, 200);
    runEndAt = Date.now();

    // Final check (state may have changed since the last poll).
    const finalSignalCtx = ctx;
    try {
      const r = await sc.check(finalSignalCtx);
      last = r;
      bestScore = Math.max(bestScore, r.score ?? (r.ok ? 1 : 0));
      if (r.ok && firstOkAt === null) firstOkAt = Date.now();
    } catch (e) {
      harnessError ??= `final check threw: ${(e as Error).message}`;
    }

    // Let any in-flight task finish so token metrics are complete (+1.5s telemetry flush).
    await waitFor(() => !taskState(readEvents(bp.eventsPath)).running, INFLIGHT_WAIT_MS, 1000);
    await sleep(1500);
  } catch (e) {
    harnessError ??= (e as Error).message;
  }

  // Collect.
  const events = readEvents(bp.eventsPath);
  const m = collectMetrics(events);
  const broken = ctx?.brokenProtected.size ?? 0;
  const earlyOk = firstOkAt !== null;
  const ok = earlyOk && broken === 0 && !harnessError;
  const botChats = ctx?.botChats ?? [];
  const firstSay = ctx?.firstSayAt ?? null;
  const firstChat = h.tester.chats.find((c) => firstSay !== null && c.at >= firstSay);
  const detail = broken > 0 ? `${last.detail}; BROKE ${broken} protected block(s) [${[...(ctx?.brokenProtected.values() ?? [])].slice(0, 4).join(" ")}]` : last.detail;
  const result: ScenarioResult = {
    id: sc.id,
    tier: sc.tier,
    category: sc.category,
    label: h.args.label,
    repeat,
    startedAt,
    ok,
    score: broken > 0 ? Math.min(bestScore, 0.5) : earlyOk ? Math.max(bestScore, 1) : bestScore,
    detail,
    timedOut: timedOut && !earlyOk,
    ...(harnessError ? { harnessError } : {}),
    wallMs: firstSay === null ? 0 : (firstOkAt ?? runEndAt) - firstSay,
    firstReplyMs: firstSay !== null && firstChat ? firstChat.at - firstSay : null,
    tasks: m.tasks,
    turns: m.turns,
    toolCalls: m.toolCalls,
    toolFailures: m.toolFailures,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreateTokens: m.cacheCreateTokens,
    costUsd: m.costUsd,
    cacheHitRate: m.cacheHitRate,
    outcomes: m.outcomes,
    violations: {
      brokenProtected: broken,
      pillarRuns: sc.pillarAllowed ? 0 : m.pillarEvents,
      chatSpam: Math.max(0, botChats.length - (sc.maxBotChats ?? 8)),
      deaths: m.deathEvents,
    },
  };

  ctx?.dispose();
  if (!ac.signal.aborted) ac.abort();
  await bp.stop();
  try {
    if (await botOnline(h)) await h.rcon.command(`kick ${h.info.username}`);
  } catch {
    /* ignore */
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const info = inspectBotDir(args.botDir);
  const env = testServerEnv();
  const sites = loadSites().sites;
  const selected = selectScenarios(args.only);
  if (selected.length === 0) throw new Error(`no scenarios match --only ${args.only}`);
  const out = resolve(REPO_ROOT, args.out ?? join("v2/runs", `${args.label}-${stamp()}`));
  mkdirSync(join(out, "logs"), { recursive: true });
  mkdirSync(join(out, "telemetry"), { recursive: true });
  const resultsPath = join(out, "results.jsonl");
  writeFileSync(resultsPath, "");
  writeFileSync(join(out, "meta.json"), JSON.stringify({ args, botDir: info.dir, botUsername: info.username, scenarios: selected.map((s) => s.id), startedAt: new Date().toISOString() }, null, 2));
  if (!args.noReset && !hasPristine()) throw new Error("no pristine world snapshot; run scout + `npx tsx src/eval/world.ts snapshot` (or pass --no-reset)");

  const rcon = makeRcon(env);
  const tester = new Tester(env.host, env.port, env.version, "Tester", info.username);
  const h: Harness = { args, info, env, rcon, tester, out, sites };
  console.log(`[eval] ${selected.length} scenario(s) x ${args.repeat} → ${out}`);

  // Ctrl+C: the process 'exit' hook in bot-process.ts kills any running bot group.
  process.on("SIGINT", () => {
    console.log("[eval] interrupted; partial results are in results.jsonl");
    process.exit(130);
  });

  for (let rep = 1; rep <= args.repeat; rep++) {
    if (!args.noReset) {
      console.log(`[eval] repeat ${rep}: restoring pristine world...`);
      tester.end();
      rcon.close();
      await restorePristine();
    }
    for (const sc of selected) {
      console.log(`[eval] ${sc.id} (rep ${rep}) ...`);
      let res: ScenarioResult;
      try {
        res = await runScenario(h, sc, rep);
      } catch (e) {
        res = blankResult(sc, args.label, rep, `harness: ${(e as Error).message}`);
      }
      appendFileSync(resultsPath, JSON.stringify(res) + "\n");
      console.log(`[eval]   ${res.ok ? "PASS" : "FAIL"} score=${res.score.toFixed(2)} wall=${(res.wallMs / 1000).toFixed(1)}s turns=${res.turns} cost=$${res.costUsd.toFixed(3)} :: ${res.harnessError ? "HARNESS " + res.harnessError : res.detail}`);
    }
  }
  tester.end();
  rcon.close();
  const summary = summaryMarkdown(loadResults(out), `${args.label} (${info.dir})`);
  writeFileSync(join(out, "summary.md"), summary);
  console.log(summary);
  console.log(`[eval] summary: ${join(out, "summary.md")}`);
}

function blankResult(sc: Scenario, label: string, repeat: number, harnessError: string): ScenarioResult {
  return {
    id: sc.id, tier: sc.tier, category: sc.category, label, repeat, startedAt: new Date().toISOString(),
    ok: false, score: 0, detail: "harness error", timedOut: false, harnessError, wallMs: 0, firstReplyMs: null,
    tasks: 0, turns: 0, toolCalls: 0, toolFailures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreateTokens: 0, costUsd: 0, cacheHitRate: null, outcomes: {},
    violations: { brokenProtected: 0, pillarRuns: 0, chatSpam: 0, deaths: 0 },
  };
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[eval] fatal: ${(e as Error).message}`);
    process.exit(1);
  },
);
