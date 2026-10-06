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
 * That grid is page 1. Number keys switch pages (telemetry + memory views,
 * all fed through `adapters.ts`, rendered by `panels.ts`):
 *
 *   1 Overview  — the layout above
 *   2 Perf      — 30m-vs-run performance table, automatic flags, live
 *                 notable-event feed, task history (outcome-colored)
 *   3 Skills    — per-skill stats (worst success first), movement & world
 *                 panel (nav results, problem spots, doors, pillar, ...),
 *                 event feed. `w` toggles the 30m window / whole run.
 *   4 Memory    — what the bot believes from disk: POIs, containers,
 *                 deaths + task queue, recent conversation tail
 *
 * Launched by `scripts/dashboard.sh` (which gates on MC server + bot PID).
 * Tab / Shift-Tab cycle bots. Quit with q / Esc / Ctrl+C — only kills this
 * viewer; the bot keeps running.
 */

import { readFileSync, statSync } from "node:fs";

import blessed, { type Widgets } from "blessed";
import contrib from "blessed-contrib";

import type { LogEntry, LogLevel } from "../observability/log-buffer.js";
import type { BotSnapshot } from "../observability/snapshot.js";
import { SNAPSHOT_PATH } from "../runtime-paths.js";
import type { SnapshotFilePayload } from "../snapshot-writer.js";
import { getMemoryView, getTelemetryView } from "./adapters.js";
import {
  pickAggregate,
  renderContainers,
  renderConversation,
  renderDeathsAndQueue,
  renderEventFeed,
  renderFlags,
  renderMovementPanel,
  renderPerfPanel,
  renderPois,
  renderSkillTable,
  renderTaskTable,
} from "./panels.js";

const POLL_MS = 500;
const ACTIONS_MAX = 50;
const LOG_BACKFILL = 80;
const ERROR_BANNER_TTL_MS = 5 * 60 * 1000;
const PAGE_NAMES = ["Overview", "Perf", "Skills", "Memory"] as const;

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

  // ─── Pages 2–4 (hidden until selected) ───────────────────────────────────
  const panel = (row: number, col: number, rowSpan: number, colSpan: number, label: string, wrap = false): Widgets.BoxElement =>
    grid.set(row, col, rowSpan, colSpan, blessed.box, {
      label,
      tags: true,
      border: { type: "line" },
      style: { border: { fg: "cyan" } },
      padding: { left: 1, right: 1 },
      scrollable: true,
      wrap, // tables clip; prose panels (flags) wrap
      hidden: true,
    }) as Widgets.BoxElement;

  // Page 2 — performance
  const perfBox = panel(0, 0, 7, 5, " Performance ");
  const flagsBox = panel(0, 5, 4, 7, " Flags (run) ", true);
  const feedBox = panel(4, 5, 3, 7, " Notable events ");
  const tasksBox = panel(7, 0, 5, 12, " Task history (newest first) ");
  // Page 3 — skills / movement
  const skillsBox = panel(0, 0, 8, 8, " Skills ");
  const moveBox = panel(0, 8, 8, 4, " Movement & world ");
  const feedBox2 = panel(8, 0, 4, 12, " Notable events ");
  // Page 4 — memory
  const poiBox = panel(0, 0, 6, 6, " POIs ");
  const containerBox = panel(0, 6, 3, 6, " Containers ");
  const deathsBox = panel(3, 6, 3, 6, " Task queue · Deaths ");
  const convBox = panel(6, 0, 6, 12, " Conversation (conversation.json, oldest first) ");

  const pages: Widgets.BlessedElement[][] = [
    [statusBox, tokenBox, inventoryBox, actionsBox, logPane],
    [perfBox, flagsBox, feedBox, tasksBox],
    [skillsBox, moveBox, feedBox2],
    [poiBox, containerBox, deathsBox, convBox],
  ];
  /** Widget whose label carries the bot name + page tabs, per page. */
  const titleBoxes: Widgets.BlessedElement[] = [statusBox, perfBox, skillsBox, poiBox];
  let activePage = 0;
  /** Page 3 window: true = last 30 min, false = whole run. */
  let skillsUseWindow = false;
  /** Extra label text for the page's title box, set by the last render. */
  const pageSuffix: string[] = ["", "", "", ""];

  const showPage = (index: number): void => {
    if (index < 0 || index >= pages.length || index === activePage) return;
    for (const w of pages[activePage]!) w.hide();
    activePage = index;
    for (const w of pages[activePage]!) w.show();
    tick();
  };

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
      titleBoxes[activePage]!.setContent(
        "\n  {yellow-fg}waiting for orchestrator snapshot…{/}\n  {gray-fg}(is the bot running? `./scripts/botStart.sh`){/}",
      );
      screen.render();
      return;
    }

    syncUsernames(Array.isArray(payload.snapshots) ? payload.snapshots : []);
    appendNewLogs(Array.isArray(payload.recentLogs) ? payload.recentLogs : []);

    if (usernamesView.length === 0) {
      titleBoxes[activePage]!.setContent("\n  {red-fg}no bots registered{/}");
      screen.render();
      return;
    }

    const username = usernamesView[activeIndex]!;
    // Fit the label to the title box: full tabs + suffix, then full tabs,
    // then compact tabs ("1 2 [3 Skills] 4") — an overlong label wraps into
    // the panel body.
    const titleBox = titleBoxes[activePage]!;
    const room = typeof titleBox.width === "number" ? titleBox.width - 4 : 999;
    const suffix = pageSuffix[activePage] ?? "";
    const full = renderPageLabel(username, activeIndex, usernamesView.length, activePage, false);
    const compact = renderPageLabel(username, activeIndex, usernamesView.length, activePage, true);
    const candidates = [suffix ? `${full}· ${suffix} ` : full, full, suffix ? `${compact}· ${suffix} ` : compact, compact];
    titleBox.setLabel(candidates.find((l) => l.length <= room) ?? compact);

    const snap = payload.snapshots.find((s) => s.username === username);
    if (!snap) {
      statusBox.setContent(`\n  {red-fg}unknown bot: ${username}{/}`);
      tokenBox.setContent("");
      inventoryBox.setItems([]);
      actionsBox.setItems([]);
      screen.render();
      return;
    }

    // A malformed / older snapshot must never take the viewer down: each
    // page renders inside its own guard and falls back to a placeholder.
    try {
      renderActivePage(snap);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      titleBoxes[activePage]!.setContent(`{red-fg}render error: ${msg.replace(/[{}]/g, "")}{/}`);
    }
    screen.title = `minecraft-endeavours · ${username}`;
    screen.render();
  };

  const innerWidth = (box: Widgets.BlessedElement): number =>
    typeof box.width === "number" ? Math.max(20, box.width - 4) : 80;

  const renderActivePage = (snap: BotSnapshot): void => {
    const now = snap.capturedAt ?? Date.now();
    switch (activePage) {
      case 0:
        statusBox.setContent(renderStatusPanel(snap));
        tokenBox.setContent(renderTokenPanel(snap));
        inventoryBox.setItems(renderInventoryLines(snap));
        actionsBox.setItems((snap.state?.recentActions ?? []).slice(-ACTIONS_MAX).reverse());
        return;
      case 1: {
        const view = getTelemetryView(snap);
        perfBox.setContent(renderPerfPanel(view));
        flagsBox.setContent(renderFlags(view));
        feedBox.setContent(renderEventFeed(view, innerWidth(feedBox), now));
        tasksBox.setContent(renderTaskTable(view, innerWidth(tasksBox), now));
        return;
      }
      case 2: {
        const view = getTelemetryView(snap);
        const agg = pickAggregate(view, skillsUseWindow);
        pageSuffix[2] = skillsUseWindow ? "last 30m (w: run)" : `whole run${view?.runTruncated ? " tail" : ""} (w: 30m)`;
        skillsBox.setContent(renderSkillTable(agg, innerWidth(skillsBox)));
        moveBox.setContent(renderMovementPanel(agg, now));
        feedBox2.setContent(renderEventFeed(view, innerWidth(feedBox2), now));
        return;
      }
      case 3: {
        const mem = getMemoryView(snap);
        const src = mem.source === "disk" ? "\n{gray-fg}(snapshot has no memory section — read from disk){/}" : "";
        pageSuffix[3] = `POIs ${mem.counts.pois ?? mem.pois.length}${mem.source === "disk" ? " (disk)" : ""}`;
        poiBox.setContent(renderPois(mem, now) + shownOf(mem.pois.length, mem.counts.pois));
        containerBox.setLabel(` Containers (${mem.counts.containers ?? mem.containers.length}) `);
        containerBox.setContent(renderContainers(mem, now) + shownOf(mem.containers.length, mem.counts.containers));
        deathsBox.setContent(renderDeathsAndQueue(mem, now));
        convBox.setLabel(` Conversation (${mem.counts.conversation ?? mem.conversation.length} on disk, oldest first) `);
        convBox.setContent(renderConversation(mem, innerWidth(convBox), now, snap.username) + src);
        return;
      }
    }
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
  screen.key(["1", "2", "3", "4"], (ch: string) => showPage(Number(ch) - 1));
  screen.key(["w"], () => {
    skillsUseWindow = !skillsUseWindow;
    tick();
  });

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

/** "showing newest N of M" footer when the snapshot only carries the latest slice. */
function shownOf(shown: number, total: number | null): string {
  return total !== null && total > shown ? `\n{gray-fg}(newest ${shown} of ${total} — full list in world.json){/}` : "";
}

function renderPageLabel(username: string, index: number, total: number, page: number, compact: boolean): string {
  const bot = total <= 1 ? username : `[${index + 1}/${total}] ${username}`;
  const tabs = PAGE_NAMES.map((name, i) => (i === page ? `[${i + 1} ${name}]` : compact ? `${i + 1}` : `${i + 1} ${name}`)).join(" ");
  return ` ${bot} · ${tabs} `;
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
  const w = a.windowStats;

  // ── 5h window — SDK is truth; bot contribution is supplement ──────────
  lines.push(`{bold}5h window{/}`);
  if (w.latestAnchor) {
    const age = snap.capturedAt - w.latestAnchor.at;
    const sdkPct = (w.latestAnchor.utilization * 100).toFixed(0);
    const status = (info?.status as string | undefined) ?? "—";
    const statusColor = status === "rejected" ? "red" : status === "allowed_warning" ? "yellow" : "green";
    lines.push(`  SDK {${statusColor}-fg}${sdkPct}%{/} {gray-fg}${formatDuration(age)} ago{/}  ({${statusColor}-fg}${status}{/})`);
    const resetsAt = info && typeof info.resetsAt === "number" ? info.resetsAt : null;
    if (resetsAt !== null) {
      lines.push(`  resets in ${formatDuration(Math.max(0, resetsAt * 1000 - snap.capturedAt))}`);
    }
    const sincePart = `bot +${formatTokens(w.botBillableSinceLastAnchor)} since`;
    if (w.estimatedCurrentUtilization !== null) {
      const pct = (w.estimatedCurrentUtilization * 100).toFixed(0);
      lines.push(`  ${sincePart} → est {yellow-fg}~${pct}%{/}`);
    } else {
      lines.push(`  ${sincePart}  {gray-fg}(need 2 anchors){/}`);
    }
  } else {
    lines.push(`  {gray-fg}waiting for SDK (fires ~80%+){/}`);
    lines.push(`  bot 5h: ${formatTokens(w.botBillableLast5h)} {gray-fg}(bot only){/}`);
  }
  if (a.rateLimited) {
    lines.push(`  {red-fg}cooldown ${a.cooldownRemainingMinutes} min{/}`);
  }

  // ── Per-turn detail (single line per user preference) ─────────────────
  lines.push("");
  if (a.lastTurnUsage) {
    const t = a.lastTurnUsage;
    const totalIn = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
    const cacheHitPct = totalIn > 0 ? (t.cache_read_input_tokens / totalIn) * 100 : 0;
    const billable = t.input_tokens + t.output_tokens;
    const cost = t.total_cost_usd !== null ? `  $${t.total_cost_usd.toFixed(4)}` : "";
    lines.push(`{bold}Last turn{/} billable ${formatTokens(billable)}${cost}`);
    lines.push(`  in ${formatTokens(t.input_tokens)}  cache_r ${formatTokens(t.cache_read_input_tokens)} (${cacheHitPct.toFixed(0)}%)  out ${formatTokens(t.output_tokens)}`);
  } else {
    lines.push(`{bold}Last turn{/} {gray-fg}no turns yet{/}`);
  }

  // ── Session totals (bot-only since startup) ───────────────────────────
  lines.push("");
  const s = a.sessionUsage;
  const sessionBillable = s.input_tokens + s.output_tokens;
  const sessionCost = s.total_cost_usd !== null ? `  $${s.total_cost_usd.toFixed(4)}` : "";
  lines.push(`{bold}Session{/} (${s.turns}t) billable ${formatTokens(sessionBillable)}${sessionCost}`);
  lines.push(`  in ${formatTokens(s.input_tokens)}  cache_r ${formatTokens(s.cache_read_input_tokens)}  out ${formatTokens(s.output_tokens)}`);

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
