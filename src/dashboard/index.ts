/**
 * Multi-bot terminal dashboard. Polls `getBotSnapshot()` for the active bot
 * every ~500ms and renders into a `blessed-contrib` grid:
 *
 *   ┌── [1/N] bot · Tab to cycle ───────────┬── 5h Pro window · Tokens ─┐
 *   │ STATE / DOING / POS / HP+FOOD / ...   │ status / util / resets    │
 *   │ TIME / TASK / QUEUE / TALK / NET      │ Last turn / Session       │
 *   │                                       ├── cache-hit % ────────────┤
 *   │                                       │ sparkline                 │
 *   ├───────────────────────────────────────┴───────────────────────────┤
 *   │ Recent actions (active bot)                                       │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │ Log (orchestrator-wide; error/warn lines colorized)               │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Mounted by `src/index.ts` when `DASHBOARD=1`. Tab / Shift-Tab cycle bots.
 * Quit with q / Esc / Ctrl+C — SIGINTs the orchestrator (single-process).
 */

import blessed from "blessed";
import contrib from "blessed-contrib";

import { listSupervisors } from "../mineflayer-glue/bot-factory.js";
import {
  getRecentLogs,
  setLogForwarding,
  subscribeToLog,
  type LogEntry,
} from "../observability/log-buffer.js";
import { getBotSnapshot, type BotSnapshot } from "../observability/snapshot.js";

const POLL_MS = 500;
const ACTIONS_MAX = 50;
const LOG_BACKFILL = 80;
const CACHE_HISTORY_MAX = 30;
const ERROR_BANNER_TTL_MS = 5 * 60 * 1000;

export interface DashboardHandle {
  unmount(): void;
}

/**
 * Mount the dashboard. With no args, cycles through every registered bot.
 * For deterministic testing, pass an explicit list.
 */
export function mountDashboard(usernames?: readonly string[]): DashboardHandle {
  const initial =
    usernames && usernames.length > 0
      ? [...usernames]
      : listSupervisors().map((s) => s.username);

  if (initial.length === 0) {
    console.warn("dashboard: no bots registered; aborting mount");
    return { unmount: () => undefined };
  }

  // Blessed owns the terminal once the screen is created — stop letting
  // console.log writes paint over the alt-screen render.
  setLogForwarding(false);

  const screen = blessed.screen({
    smartCSR: true,
    title: `minecraft-endeavours · ${initial[0]}`,
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const statusBox = grid.set(0, 0, 6, 7, blessed.box, {
    label: "",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    padding: { left: 1, right: 1 },
  });

  const tokenBox = grid.set(0, 7, 4, 5, blessed.box, {
    label: " 5h Pro window · Tokens ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    padding: { left: 1, right: 1 },
  });

  const sparkline = grid.set(4, 7, 2, 5, contrib.sparkline, {
    label: " Cache hit % (per turn) ",
    tags: true,
    style: { fg: "green", titleFg: "white" },
    border: { type: "line", fg: "cyan" },
  });

  const actionsBox = grid.set(6, 0, 3, 12, blessed.list, {
    label: " Recent actions ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, item: { fg: "white" } },
    items: [],
    interactive: false,
  });

  const logPane = grid.set(9, 0, 3, 12, contrib.log, {
    label: " Log ",
    bufferLength: 200,
    tags: true,
    fg: "white",
  });

  for (const entry of getRecentLogs(LOG_BACKFILL)) {
    logPane.log(formatLogLine(entry));
  }

  const unsubscribeLog = subscribeToLog((entry) => {
    logPane.log(formatLogLine(entry));
    screen.render();
  });

  // ─── Multi-bot state ──────────────────────────────────────────────────────
  let usernamesView: string[] = [...initial];
  let activeIndex = 0;
  // Per-bot cache-hit history (last N turns).
  const cacheHistory = new Map<string, number[]>();
  // Per-bot last seen turn count — used to detect when a new turn lands.
  const lastSeenTurns = new Map<string, number>();
  for (const u of usernamesView) {
    cacheHistory.set(u, []);
    lastSeenTurns.set(u, 0);
  }

  const refreshUsernames = (): void => {
    // Pick up bots added later (none today, but future-proof).
    const fresh = listSupervisors().map((s) => s.username);
    if (fresh.length === 0) return;
    const merged = [...new Set([...usernamesView, ...fresh])].filter((u) =>
      fresh.includes(u),
    );
    if (merged.join("|") !== usernamesView.join("|")) {
      usernamesView = merged;
      for (const u of usernamesView) {
        if (!cacheHistory.has(u)) cacheHistory.set(u, []);
        if (!lastSeenTurns.has(u)) lastSeenTurns.set(u, 0);
      }
      if (activeIndex >= usernamesView.length) activeIndex = 0;
    }
  };

  const cycle = (delta: number): void => {
    refreshUsernames();
    if (usernamesView.length === 0) return;
    activeIndex =
      (activeIndex + delta + usernamesView.length) % usernamesView.length;
    tick();
  };

  // ─── Render tick ──────────────────────────────────────────────────────────
  const tick = (): void => {
    refreshUsernames();
    const username = usernamesView[activeIndex];
    if (!username) {
      statusBox.setContent("\n  {red-fg}no bots registered{/}");
      screen.render();
      return;
    }

    statusBox.setLabel(renderStatusLabel(username, activeIndex, usernamesView.length));

    const snap = getBotSnapshot(username);
    if (!snap) {
      statusBox.setContent(`\n  {red-fg}unknown bot: ${username}{/}`);
      tokenBox.setContent("");
      sparkline.setData(["cache %"], [[]]);
      actionsBox.setItems([]);
      screen.render();
      return;
    }

    // Update cache-hit history for every bot whenever a new turn lands, not
    // just the active one — so switching tabs shows a populated sparkline.
    updateCacheHistoryForAllBots(cacheHistory, lastSeenTurns);

    statusBox.setContent(renderStatusPanel(snap));
    tokenBox.setContent(renderTokenPanel(snap));
    sparkline.setData(["cache %"], [cacheHistory.get(username) ?? []]);
    actionsBox.setItems(snap.state.recentActions.slice(-ACTIONS_MAX).reverse());
    screen.title = `minecraft-endeavours · ${username}`;
    screen.render();
  };

  tick();
  const interval = setInterval(tick, POLL_MS);

  let unmounted = false;
  const unmount = (): void => {
    if (unmounted) return;
    unmounted = true;
    clearInterval(interval);
    unsubscribeLog();
    screen.destroy();
    setLogForwarding(true);
  };

  screen.key(["q", "C-c", "escape"], () => {
    unmount();
    process.kill(process.pid, "SIGINT");
  });
  screen.key(["tab"], () => cycle(1));
  screen.key(["S-tab"], () => cycle(-1));

  screen.render();
  return { unmount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bot cache-hit history. Polled rather than event-driven so we don't have
// to thread a callback into the agent — the snapshot already tells us when
// turn count increments.
// ─────────────────────────────────────────────────────────────────────────────

function updateCacheHistoryForAllBots(
  cacheHistory: Map<string, number[]>,
  lastSeenTurns: Map<string, number>,
): void {
  for (const username of cacheHistory.keys()) {
    const snap = getBotSnapshot(username);
    if (!snap?.agent) continue;
    const turns = snap.agent.sessionUsage.turns;
    const prevTurns = lastSeenTurns.get(username) ?? 0;
    if (turns <= prevTurns) continue;

    lastSeenTurns.set(username, turns);
    const t = snap.agent.lastTurnUsage;
    if (!t) continue;
    const totalIn = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
    const pct = totalIn > 0 ? (t.cache_read_input_tokens / totalIn) * 100 : 0;
    const history = cacheHistory.get(username) ?? [];
    history.push(Math.round(pct));
    while (history.length > CACHE_HISTORY_MAX) history.shift();
    cacheHistory.set(username, history);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderStatusLabel(username: string, index: number, total: number): string {
  if (total <= 1) return ` ${username} `;
  return ` [${index + 1}/${total}] ${username} · Tab to cycle `;
}

function renderStatusPanel(snap: BotSnapshot): string {
  const lines: string[] = [];
  const conn = snap.connection;
  const bot = snap.bot;
  const st = snap.state;
  const agent = snap.agent;

  const stateColor =
    conn.state === "connected" ? "green" :
    conn.state === "reconnecting" ? "yellow" :
    conn.state === "stopped" ? "red" : "gray";

  const stateLabel =
    agent?.rateLimited ? `{magenta-fg}rate-limited{/}` :
    st.currentTool ? `{cyan-fg}working{/}` :
    conn.state === "connected" ? `{green-fg}idle{/}` :
    `{${stateColor}-fg}${conn.state}{/}`;

  lines.push(`{bold}STATE{/}    ${stateLabel}`);

  if (st.currentTool) {
    lines.push(`{bold}DOING{/}    ${st.currentTool.name} — ${formatDuration(st.currentTool.runningMs)}`);
  } else {
    lines.push(`{bold}DOING{/}    {gray-fg}—{/}`);
  }

  if (bot) {
    lines.push(`{bold}POS{/}      ${bot.position.x.toFixed(1)}, ${bot.position.y.toFixed(1)}, ${bot.position.z.toFixed(1)}  ({gray-fg}${bot.facing}{/})`);
    lines.push(`{bold}HP/FOOD{/}  ${bot.health}/20  ·  ${bot.food}/20  ({gray-fg}sat ${bot.saturation}{/})`);
    lines.push(`{bold}TIME{/}     ${bot.time.phase} (${bot.time.timeOfDay})  ·  {bold}WEATHER{/} ${bot.weather}`);
  } else {
    lines.push(`{bold}POS{/}      {gray-fg}—{/}`);
    lines.push(`{bold}HP/FOOD{/}  {gray-fg}—{/}`);
    lines.push(`{bold}TIME{/}     {gray-fg}—{/}`);
  }

  if (st.currentTask) {
    lines.push(`{bold}TASK{/}     ${st.currentTask}`);
    lines.push(`{bold}QUEUE{/}    ${st.remainingTasks.length} remaining`);
  } else {
    lines.push(`{bold}TASK{/}     {gray-fg}—{/}`);
    lines.push(`{bold}QUEUE{/}    {gray-fg}empty{/}`);
  }

  lines.push(`{bold}TALK{/}     ${snap.chat.currentPartner ?? "{gray-fg}—{/}"}`);

  const netLine = conn.uptimeMs !== null
    ? `${conn.state} · uptime ${formatDuration(conn.uptimeMs)}`
    : conn.state;
  lines.push(`{bold}NET{/}      {${stateColor}-fg}${netLine}{/}`);

  // Error banner — only show if recent enough to still be relevant.
  if (agent?.lastTurnError) {
    const age = snap.capturedAt - agent.lastTurnError.at;
    if (age < ERROR_BANNER_TTL_MS) {
      lines.push("");
      lines.push(`{red-fg}{bold}LAST ERR{/} ${agent.lastTurnError.subtype} ({gray-fg}${formatDuration(age)} ago{/}){/}`);
    }
  }

  return lines.join("\n");
}

function renderTokenPanel(snap: BotSnapshot): string {
  const a = snap.agent;
  if (!a) return "  {gray-fg}agent not started{/}";

  const lines: string[] = [];
  const info = a.rateLimitInfo;

  if (info === null) {
    lines.push(`{gray-fg}no rate-limit event yet{/}`);
  } else {
    const status = (info.status as string | undefined) ?? "unknown";
    const statusColor = status === "rejected" ? "red" : status === "allowed_warning" ? "yellow" : "green";
    lines.push(`status:  {${statusColor}-fg}${status}{/}`);

    const util = info.utilization;
    if (typeof util === "number") {
      lines.push(`util:    ${(util * 100).toFixed(0)}%`);
    }

    const resetsAt = info.resetsAt;
    if (typeof resetsAt === "number") {
      const inMs = resetsAt * 1000 - snap.capturedAt;
      lines.push(`resets:  in ${formatDuration(Math.max(0, inMs))}`);
    }
  }

  if (a.rateLimited) {
    lines.push(`{red-fg}cooldown ${a.cooldownRemainingMinutes} min{/}`);
  }

  lines.push("");
  lines.push(`{bold}Last turn{/}`);
  if (a.lastTurnUsage) {
    const t = a.lastTurnUsage;
    const totalIn = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
    const cacheHitPct = totalIn > 0 ? (t.cache_read_input_tokens / totalIn) * 100 : 0;
    lines.push(`  in ${formatTokens(totalIn)}  out ${formatTokens(t.output_tokens)}`);
    lines.push(`  cache ${cacheHitPct.toFixed(0)}%${t.total_cost_usd !== null ? `  $${t.total_cost_usd.toFixed(4)}` : ""}`);
  } else {
    lines.push(`  {gray-fg}no turns yet{/}`);
  }

  lines.push("");
  const s = a.sessionUsage;
  lines.push(`{bold}Session{/} (${s.turns} turn${s.turns === 1 ? "" : "s"})`);
  const totalSessionIn = s.input_tokens + s.cache_creation_input_tokens + s.cache_read_input_tokens;
  lines.push(`  in ${formatTokens(totalSessionIn)}  out ${formatTokens(s.output_tokens)}`);
  if (s.total_cost_usd !== null) {
    lines.push(`  cost $${s.total_cost_usd.toFixed(4)}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatLogLine(entry: LogEntry): string {
  const t = new Date(entry.at);
  const hh = pad2(t.getHours());
  const mm = pad2(t.getMinutes());
  const ss = pad2(t.getSeconds());
  const ts = `{gray-fg}${hh}:${mm}:${ss}{/}`;
  const color =
    entry.level === "error" ? "red-fg" :
    entry.level === "warn" ? "yellow-fg" :
    "white-fg";
  const text = entry.text.replace(/\r/g, "").replace(/\n/g, " ");
  return `${ts} {${color}}${text}{/}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
