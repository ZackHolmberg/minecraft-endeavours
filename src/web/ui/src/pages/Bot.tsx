import { useEffect, useMemo, useState } from "preact/hooks";
import type { ReportResponse, SnapshotResponse } from "../../../shared/api.js";
import type { BotSnapshot } from "../../../../observability/snapshot.js";
import type { TelemetryEvent } from "../../../../observability/telemetry-types.js";
import { useChannel, useFetch, useNow } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";
import { status } from "../lib/status.js";
import { navigate } from "../lib/router.js";
import { fmtAgo, fmtDuration } from "../lib/format.js";
import { Alert, Badge, Card, Empty, ErrorState, Segmented, Skeleton, type Tone } from "../components/ui.js";
import { MODE_LABEL, setGameMode } from "../lib/gamemode.js";
import { IBot } from "../components/icons.js";
import { LivePanel, MemoryPanel } from "./bot/Live.js";
import { PerfPanel } from "./bot/Perf.js";
import { MovementPanel, SkillsPanel } from "./bot/Skills.js";
import { EventsPanel } from "./bot/Events.js";

export type WindowKey = "30m" | "run" | "2h" | "today" | "all";
const WINDOWS: Array<{ value: WindowKey; label: string }> = [
  { value: "30m", label: "30 min" },
  { value: "run", label: "This run" },
  { value: "today", label: "Today" },
  { value: "all", label: "All" },
];

type Tab = "live" | "perf" | "skills" | "movement" | "memory" | "events";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "live", label: "Live" },
  { id: "perf", label: "Performance" },
  { id: "skills", label: "Skills" },
  { id: "movement", label: "Movement & world" },
  { id: "memory", label: "Memory" },
  { id: "events", label: "Events" },
];

const DEFAULT_BOT = "Steve_AI";

function readPref<T extends string>(k: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(k);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  } catch {
    return dflt;
  }
}
function writePref(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

export function connTone(state: string | undefined): Tone {
  return state === "connected" ? "good" : state === "reconnecting" || state === "connecting" ? "warn" : "neutral";
}

export function Bot({ tab: routeTab }: { tab: string | null }) {
  const st = useStore(status);
  const now = useNow(1000);
  const snap = useFetch<SnapshotResponse>("/api/bot/snapshot");
  const [snapAt, setSnapAt] = useState(0);
  useEffect(() => {
    if (snap.data) setSnapAt(Date.now());
  }, [snap.data]);
  useChannel("snapshot", (m) => {
    if (m.type === "snapshot") {
      snap.setData(m.data);
      setSnapAt(Date.now());
    }
  });

  const names = useMemo(() => {
    const s = new Set<string>();
    for (const b of snap.data ?? []) s.add(b.username);
    for (const b of st.data?.bot.bots ?? []) s.add(b.username);
    if (s.size === 0) s.add(DEFAULT_BOT);
    return [...s];
  }, [snap.data, st.data?.bot.bots]);

  const [bot, setBot] = useState<string>(() => {
    try {
      return localStorage.getItem("panel.bot") ?? DEFAULT_BOT;
    } catch {
      return DEFAULT_BOT;
    }
  });
  const current = names.includes(bot) ? bot : names[0]!;
  const tab: Tab = TABS.some((t) => t.id === routeTab) ? (routeTab as Tab) : readPref("panel.botTab", TABS.map((t) => t.id), "live");
  const setTab = (t: Tab) => navigate(`/bot/${t}`);
  const [win, setWin] = useState<WindowKey>(() => readPref("panel.botWindow", ["30m", "run", "2h", "today", "all"] as const, "run"));

  const report = useFetch<ReportResponse>(`/api/bot/report?bot=${encodeURIComponent(current)}&since=${win}`, { interval: 15_000 });
  const eventsSince = report.data?.window.from ?? null;
  const taskEvents = useFetch<TelemetryEvent[]>(
    eventsSince !== null ? `/api/bot/events?bot=${encodeURIComponent(current)}&since=${eventsSince}&kinds=task_start,task_end&limit=500` : null,
    { interval: 30_000 },
  );

  const s: BotSnapshot | null = (snap.data ?? []).find((b) => b.username === current) ?? null;
  const snapStale = s !== null && now - snapAt > 10_000;
  const botDown = st.data ? !st.data.bot.running : false;

  const windowCtl = (
    <Segmented
      label="Time window"
      value={win}
      options={WINDOWS}
      onChange={(v) => {
        setWin(v);
        writePref("panel.botWindow", v);
      }}
    />
  );

  return (
    <div class="stack">
      <BotHeader
        s={s}
        names={names}
        current={current}
        onPick={(n) => {
          setBot(n);
          writePref("panel.bot", n);
        }}
        botDown={botDown}
        stale={snapStale}
        now={now}
      />
      <div class="subtabs" role="tablist" aria-label="Bot sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="bot-panel"
            onClick={() => {
              setTab(t.id);
              writePref("panel.botTab", t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="bot-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "live" &&
          (s ? (
            <LivePanel s={s} now={now} />
          ) : snap.data === null && !snap.error ? (
            <Skeleton lines={6} />
          ) : (
            <OfflineState botDown={botDown} error={snap.error} what="Live state" />
          ))}
        {tab === "memory" &&
          (s ? <MemoryPanel s={s} now={now} /> : <OfflineState botDown={botDown} error={snap.error} what="The memory view" />)}
        {(tab === "perf" || tab === "skills" || tab === "movement") && (
          <div class="stack">
            <div class="row wrap between">
              {windowCtl}
              {report.data && (
                <span class="small dim">
                  {report.data.window.label} · {fmtDuration(report.data.window.to - report.data.window.from)}
                  {s?.telemetry.runTruncated && win === "run" ? " · run truncated to in-memory tail" : ""}
                </span>
              )}
            </div>
            {report.data === null ? (
              report.errorStatus === 404 ? (
                <Card>
                  <Empty icon={<IBot />} title="No telemetry yet">
                    The panel found no telemetry for {current}. It's written while the bot runs, so start the bot and check back.
                  </Empty>
                </Card>
              ) : report.error ? (
                <ErrorState error={report.error} onRetry={report.reload} />
              ) : (
                <Skeleton lines={6} />
              )
            ) : (
              <>
                {report.error && <Alert tone="warn" title="Showing last loaded report">{report.error}</Alert>}
                {tab === "perf" && <PerfPanel r={report.data} tasks={taskEvents.data} tasksError={taskEvents.error} />}
                {tab === "skills" && <SkillsPanel agg={report.data.aggregate} />}
                {tab === "movement" && <MovementPanel agg={report.data.aggregate} />}
              </>
            )}
          </div>
        )}
        {tab === "events" && <EventsPanel bot={current} />}
      </div>
    </div>
  );
}

function BotHeader(props: {
  s: BotSnapshot | null;
  names: string[];
  current: string;
  onPick: (n: string) => void;
  botDown: boolean;
  stale: boolean;
  now: number;
}) {
  const { s, now } = props;
  const conn = s?.connection.state;
  const agent = s?.agent;
  return (
    <Card>
      <div class="row bot-head" style={{ gap: "12px" }}>
        <div class={`hero-icon ${conn === "connected" ? "good" : conn ? "warn" : ""}`}>
          <IBot />
        </div>
        <div class="grow">
          {props.names.length > 1 ? (
            <label class="row">
              <span class="sr-only">Bot</span>
              <select class="input" style={{ maxWidth: "240px", fontWeight: 650 }} value={props.current} onChange={(e) => props.onPick((e.target as HTMLSelectElement).value)}>
                {props.names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div class="hero-value">{props.current}</div>
          )}
          <div class="row wrap small muted" style={{ gap: "4px 12px", marginTop: "4px" }}>
            {s ? (
              <>
                <Badge tone={connTone(conn)}>{conn}</Badge>
                {s.connection.uptimeMs !== null && <span>in world {fmtDuration(s.connection.uptimeMs)}</span>}
                {s.chat.currentPartner && <span>talking to <strong>{s.chat.currentPartner}</strong></span>}
                {props.stale && <Badge tone="warn">snapshot {fmtAgo(s.capturedAt, now)}</Badge>}
              </>
            ) : (
              <Badge tone="neutral">{props.botDown ? "orchestrator stopped" : "no live snapshot"}</Badge>
            )}
            {agent?.rateLimited && <Badge tone="bad">rate-limited · {agent.cooldownRemainingMinutes}m</Badge>}
          </div>
        </div>
      </div>
      {s && <BotGameMode name={s.username} mode={s.bot?.gameMode ?? "unknown"} online={conn === "connected"} />}
      {agent?.lastTurnError && (
        <div style={{ marginTop: "12px" }}>
          <Alert tone="bad" title="Last turn errored">
            <code>{agent.lastTurnError.subtype}</code> · {fmtAgo(agent.lastTurnError.at, now)}
          </Alert>
        </div>
      )}
    </Card>
  );
}

function BotGameMode({ name, mode, online }: { name: string; mode: string; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const known = mode === "survival" || mode === "creative" || mode === "adventure" || mode === "spectator";
  const pick = async (m: "survival" | "creative") => {
    if (m === mode || busy) return;
    setBusy(true);
    try {
      await setGameMode(name, m); // the next snapshot (≤1s) reflects the change
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="row wrap between" style={{ marginTop: "12px", gap: "8px 12px" }}>
      <div class="small muted">
        Game mode <strong style={{ color: "var(--text)" }}>{known ? MODE_LABEL[mode] : "unknown"}</strong>
        {busy && <span class="spinner" aria-hidden="true" style={{ width: "12px", height: "12px", marginLeft: "8px" }} />}
      </div>
      <div class="seg" role="group" aria-label={`Game mode for ${name}`}>
        {(["survival", "creative"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} disabled={!online || busy} onClick={() => void pick(m)} title={online ? undefined : "The bot must be connected"}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
    </div>
  );
}

function OfflineState({ botDown, error, what }: { botDown: boolean; error: string | null; what: string }) {
  if (error) return <ErrorState error={error} />;
  return (
    <Card>
      <Empty icon={<IBot />} title={botDown ? "The bot isn't running" : "No live snapshot"}>
        {what} comes from the running orchestrator.{" "}
        {botDown ? "Start the bot from the overview." : "It may still be connecting."} Performance, skills and movement still work from the on-disk telemetry.
      </Empty>
    </Card>
  );
}
