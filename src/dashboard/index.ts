/**
 * Multi-bot terminal dashboard. Runs as a standalone process — not in the
 * orchestrator's address space. The orchestrator (`scripts/botStart.sh`)
 * writes `.bot-runtime/snapshot.json` every 500ms via `src/snapshot-writer.ts`;
 * this client polls that file and renders into a `blessed-contrib` grid:
 *
 *   ┌── [1/N] bot · Tab to cycle ───────────┬── 5h Pro window · Tokens ─┐
 *   │ STATE / DOING / POS / HP+FOOD / ...   │ status / util / resets    │
 *   │ TIME / TASK / QUEUE / TALK / NET      │ Last turn / Session       │
 *   │                                       ├── Inventory ──────────────┤
 *   │                                       │ name × N (grouped)        │
 *   ├───────────────────────────────────────┴───────────────────────────┤
 *   │ Recent actions (active bot)                                       │
 *   ├───────────────────────────────────────────────────────────────────┤
 *   │ Log (orchestrator-wide; error/warn lines colorized)               │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Launched by `scripts/dashboard.sh` (which gates on MC server + bot PID).
 * Tab / Shift-Tab cycle bots. Quit with q / Esc / Ctrl+C — only kills this
 * viewer; the bot keeps running.
 */

import { readFileSync, statSync } from "node:fs";

import blessed from "blessed";
import contrib from "blessed-contrib";

import type { LogEntry, LogLevel } from "../observability/log-buffer.js";
import type { BotSnapshot } from "../observability/snapshot.js";
import { SNAPSHOT_PATH } from "../runtime-paths.js";
import type { SnapshotFilePayload } from "../snapshot-writer.js";

const POLL_MS = 500;
const ACTIONS_MAX = 50;
const LOG_BACKFILL = 80;
const ERROR_BANNER_TTL_MS = 5 * 60 * 1000;

function readSnapshotFile(): SnapshotFilePayload | null {
  try {
    statSync(SNAPSHOT_PATH);
  } catch {
    return null;
  }
  try {
    const raw = readFileSync(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw) as SnapshotFilePayload;
  } catch {
    // Atomic rename means we shouldn't see partial writes, but a JSON parse
    // failure (e.g. file briefly empty during boot) shouldn't kill the
    // dashboard — just skip this tick.
    return null;
  }
}

function mountDashboard(): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: "minecraft-endeavours",
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

  const inventoryBox = grid.set(4, 7, 2, 5, blessed.list, {
    label: " Inventory ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, item: { fg: "white" } },
    items: [],
    scrollable: true,
    interactive: false,
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

  // ─── Multi-bot state ──────────────────────────────────────────────────────
  let usernamesView: string[] = [];
  let activeIndex = 0;
  // Track the last log entry we rendered so we only append fresh lines on
  // subsequent polls. Matched on (at, level, text) — Date.now() can repeat.
  let lastLogKey: string | null = null;
  // Show initial backfill exactly once.
  let backfilled = false;

  const logKeyFor = (entry: LogEntry): string =>
    `${entry.at}|${entry.level}|${entry.text}`;

  const syncUsernames = (snapshots: BotSnapshot[]): void => {
    const fresh = snapshots.map((s) => s.username);
    const merged = fresh.filter((u) => fresh.includes(u));
    if (merged.join("|") !== usernamesView.join("|")) {
      usernamesView = merged;
      if (activeIndex >= usernamesView.length) activeIndex = 0;
    }
  };

  const appendNewLogs = (logs: LogEntry[]): void => {
    if (logs.length === 0) return;

    if (!backfilled) {
      const tail = logs.slice(-LOG_BACKFILL);
      for (const entry of tail) logPane.log(formatLogLine(entry));
      lastLogKey = tail.length > 0 ? logKeyFor(tail[tail.length - 1]!) : null;
      backfilled = true;
      return;
    }

    let cutoff = -1;
    if (lastLogKey !== null) {
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logKeyFor(logs[i]!) === lastLogKey) {
          cutoff = i;
          break;
        }
      }
    }
    const fresh = logs.slice(cutoff + 1);
    for (const entry of fresh) logPane.log(formatLogLine(entry));
    if (fresh.length > 0) {
      lastLogKey = logKeyFor(fresh[fresh.length - 1]!);
    }
  };

  const cycle = (delta: number): void => {
    if (usernamesView.length === 0) return;
    activeIndex =
      (activeIndex + delta + usernamesView.length) % usernamesView.length;
    tick();
  };

  // ─── Render tick ──────────────────────────────────────────────────────────
  const tick = (): void => {
    const payload = readSnapshotFile();

    if (!payload) {
      statusBox.setContent(
        "\n  {yellow-fg}waiting for orchestrator snapshot…{/}\n  {gray-fg}(is the bot running? `./scripts/botStart.sh`){/}",
      );
      screen.render();
      return;
    }

    syncUsernames(payload.snapshots);
    appendNewLogs(payload.recentLogs);

    if (usernamesView.length === 0) {
      statusBox.setContent("\n  {red-fg}no bots registered{/}");
      screen.render();
      return;
    }

    const username = usernamesView[activeIndex]!;
    statusBox.setLabel(renderStatusLabel(username, activeIndex, usernamesView.length));

    const snap = payload.snapshots.find((s) => s.username === username);
    if (!snap) {
      statusBox.setContent(`\n  {red-fg}unknown bot: ${username}{/}`);
      tokenBox.setContent("");
      inventoryBox.setItems([]);
      actionsBox.setItems([]);
      screen.render();
      return;
    }

    statusBox.setContent(renderStatusPanel(snap));
    tokenBox.setContent(renderTokenPanel(snap));
    inventoryBox.setItems(renderInventoryLines(snap));
    actionsBox.setItems(snap.state.recentActions.slice(-ACTIONS_MAX).reverse());
    screen.title = `minecraft-endeavours · ${username}`;
    screen.render();
  };

  tick();
  const interval = setInterval(tick, POLL_MS);

  const unmount = (): void => {
    clearInterval(interval);
    screen.destroy();
  };

  screen.key(["q", "C-c", "escape"], () => {
    unmount();
    process.exit(0);
  });
  screen.key(["tab"], () => cycle(1));
  screen.key(["S-tab"], () => cycle(-1));

  screen.render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel renderers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group the snapshot's per-stack list by item name (so 64 + 12 dirt becomes
 * one "dirt × 76" row), sort alphabetically, render as fixed-width lines.
 * Returns a placeholder line when the inventory is empty.
 */
function renderInventoryLines(snap: BotSnapshot): string[] {
  const items = snap.bot?.inventory;
  if (!items || items.length === 0) return ["{gray-fg}(empty){/}"];
  const totals = new Map<string, number>();
  for (const stack of items) {
    totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count);
  }
  return Array.from(totals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} {gray-fg}×{/} ${count}`);
}

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
    if (st.remainingTasks.length === 0) {
      lines.push(`{bold}QUEUE{/}    {gray-fg}(none){/}`);
    } else {
      lines.push(`{bold}QUEUE{/}    ${st.remainingTasks.length} remaining:`);
      for (let i = 0; i < st.remainingTasks.length; i++) {
        const num = String(i + 1).padStart(2, " ");
        lines.push(`         {gray-fg}${num}.{/} ${truncate(st.remainingTasks[i]!, 60)}`);
      }
    }
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
  const color: Record<LogLevel, string> = {
    error: "red-fg",
    warn: "yellow-fg",
    info: "white-fg",
    log: "white-fg",
  };
  const text = entry.text.replace(/\r/g, "").replace(/\n/g, " ");
  return `${ts} {${color[entry.level]}}${text}{/}`;
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

mountDashboard();
