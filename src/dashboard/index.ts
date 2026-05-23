/**
 * Single-bot terminal dashboard. Polls `getBotSnapshot(username)` every
 * ~500ms and renders into a `blessed-contrib` grid:
 *
 *   ┌── status (bot, position, hp/food, task, talk, net) ──┬── 5h Pro window + tokens ──┐
 *   │                                                       │                            │
 *   ├───────────────────────────────────────────────────────┴────────────────────────────┤
 *   │ Recent actions (last 5 min, from state.actions)                                    │
 *   ├────────────────────────────────────────────────────────────────────────────────────┤
 *   │ Log (live tail of console output via the ring-buffer logger)                       │
 *   └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Mounted by `src/index.ts` when `DASHBOARD=1` is set. Quit with q / Esc /
 * Ctrl+C — exits the whole orchestrator (single-process model per ROADMAP;
 * IPC split is future work).
 */

import blessed from "blessed";
import contrib from "blessed-contrib";

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

export interface DashboardHandle {
  unmount(): void;
}

export function mountDashboard(username: string): DashboardHandle {
  // Blessed owns the terminal once the screen is created — stop letting
  // console.log writes paint over the alt-screen render. Everything still
  // lands in the ring buffer, so the log pane stays complete.
  setLogForwarding(false);

  const screen = blessed.screen({
    smartCSR: true,
    title: `minecraft-endeavours · ${username}`,
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const statusBox = grid.set(0, 0, 6, 7, blessed.box, {
    label: ` ${username} `,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    padding: { left: 1, right: 1 },
  });

  const tokenBox = grid.set(0, 7, 6, 5, blessed.box, {
    label: " 5h Pro window · Tokens ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    padding: { left: 1, right: 1 },
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

  const tick = (): void => {
    const snap = getBotSnapshot(username);
    if (!snap) {
      statusBox.setContent(`\n  {red-fg}unknown bot: ${username}{/}`);
      tokenBox.setContent("");
      actionsBox.setItems([]);
    } else {
      statusBox.setContent(renderStatusPanel(snap));
      tokenBox.setContent(renderTokenPanel(snap));
      actionsBox.setItems(snap.state.recentActions.slice(-ACTIONS_MAX).reverse());
    }
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
    // Bring the orchestrator down with the dashboard — single-process model.
    process.kill(process.pid, "SIGINT");
  });

  screen.render();
  return { unmount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel renderers
// ─────────────────────────────────────────────────────────────────────────────

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
  // Strip the alt-screen-corrupting carriage returns mineflayer occasionally
  // emits, and collapse newlines so each entry is one log line.
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
