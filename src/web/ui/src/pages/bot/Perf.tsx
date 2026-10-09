import { useMemo, useState } from "preact/hooks";
import type { ReportResponse } from "../../../../shared/api.js";
import type { TaskOutcome, TelemetryEvent } from "../../../../../observability/telemetry-types.js";
// Pure threshold constants — shared with the report CLI so the UI's cues match its flags.
import {
  CACHE_HIT_MIN,
  CONTEXT_BUILD_P95_MAX_MS,
  FIRST_REPLY_P50_MAX_MS,
  FIRST_REPLY_P95_MAX_MS,
  NEAR_CAP_TURNS,
  TURN_CAP,
} from "../../../../../report/flags.js";
import { fmtMs, fmtNum, fmtPct, fmtUsd, fmtWhen } from "../../lib/format.js";
import { Badge, Card, Tile, type Tone } from "../../components/ui.js";
import { StackBar, TimeChart } from "../../components/charts.js";
import { IAlert, ICheck, IInfo } from "../../components/icons.js";

type StartEv = Extract<TelemetryEvent, { kind: "task_start" }>;
type EndEv = Extract<TelemetryEvent, { kind: "task_end" }>;

export const OUTCOMES: Array<{ key: TaskOutcome; label: string; tone: Tone }> = [
  { key: "finished", label: "Finished", tone: "good" },
  { key: "stopped", label: "Stopped", tone: "neutral" },
  { key: "max_turns", label: "Turn cap", tone: "warn" },
  { key: "failed", label: "Failed", tone: "bad" },
  { key: "rate_limited", label: "Rate-limited", tone: "warn" },
];
const outcomeMeta = (o: TaskOutcome) => OUTCOMES.find((x) => x.key === o) ?? { key: o, label: o, tone: "neutral" as Tone };

export interface TaskRow {
  id: string;
  start: StartEv | null;
  end: EndEv | null;
  at: number;
}

export function joinTasks(events: TelemetryEvent[] | null): TaskRow[] {
  if (!events) return [];
  const m = new Map<string, TaskRow>();
  for (const e of events) {
    if ((e.kind !== "task_start" && e.kind !== "task_end") || !e.taskId) continue;
    const r = m.get(e.taskId) ?? { id: e.taskId, start: null, end: null, at: e.at };
    if (e.kind === "task_start") {
      r.start = e;
      r.at = e.at;
    } else r.end = e;
    m.set(e.taskId, r);
  }
  return [...m.values()].sort((a, b) => b.at - a.at);
}

export function PerfPanel({ r, tasks, tasksError }: { r: ReportResponse; tasks: TelemetryEvent[] | null; tasksError: string | null }) {
  const t = r.aggregate.tasks;
  const rows = useMemo(() => joinTasks(tasks), [tasks]);
  const finishedRows = rows.filter((x) => x.end);
  const perTask = t.count > 0 && t.costUsd !== null ? t.costUsd / t.count : null;
  const totalTok = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheCreate;

  const frSeries = finishedRows
    .filter((x) => x.end!.firstReplyMs !== null)
    .map((x) => ({
      x: x.end!.at,
      y: x.end!.firstReplyMs! / 1000,
      tip: `${fmtMs(x.end!.firstReplyMs)} · “${x.start?.request ?? "?"}”`,
      bad: x.end!.firstReplyMs! > FIRST_REPLY_P95_MAX_MS,
    }));
  const turnSeries = finishedRows.map((x) => ({
    x: x.end!.at,
    y: x.end!.turns,
    tip: `${x.end!.turns} turns · ${outcomeMeta(x.end!.outcome).label} · “${x.start?.request ?? "?"}”`,
    bad: x.end!.outcome === "max_turns" || x.end!.turns >= NEAR_CAP_TURNS,
  }));

  return (
    <div class="stack">
      <Flags flags={r.flags} taskCount={t.count} />

      <div class="grid tiles">
        <Tile
          label="First reply p50"
          value={fmtMs(t.firstReplyMs.p50)}
          sub={`p95 ${fmtMs(t.firstReplyMs.p95)} · n=${t.firstReplyMs.count}`}
          tone={t.firstReplyMs.p50 !== null && t.firstReplyMs.p50 > FIRST_REPLY_P50_MAX_MS ? "warn" : undefined}
        />
        <Tile
          label="Turns / task"
          value={t.turns.p50 ?? "—"}
          unit="p50"
          sub={`p95 ${t.turns.p95 ?? "—"} · max ${t.turns.max ?? "—"} / ${TURN_CAP}`}
          tone={(t.byOutcome.max_turns ?? 0) > 0 ? "bad" : t.turns.max !== null && t.turns.max >= NEAR_CAP_TURNS ? "warn" : undefined}
        />
        <Tile
          label="Cache hit"
          value={fmtPct(t.cacheHitRate)}
          sub={`${fmtNum(t.tokens.cacheRead)} of ${fmtNum(totalTok)} input`}
          tone={t.cacheHitRate !== null && t.cacheHitRate < CACHE_HIT_MIN && t.count >= 3 ? "warn" : undefined}
        />
        <Tile label="Cost" value={fmtUsd(t.costUsd)} sub={perTask !== null ? `${fmtUsd(perTask)} / task` : "—"} />
        <Tile
          label="Context build"
          value={fmtMs(t.contextBuildMs.p50)}
          unit="p50"
          sub={`p95 ${fmtMs(t.contextBuildMs.p95)}${t.contextTimeouts ? ` · ${t.contextTimeouts} timeouts` : ""}`}
          tone={t.contextTimeouts > 0 ? "warn" : t.contextBuildMs.p95 !== null && t.contextBuildMs.p95 > CONTEXT_BUILD_P95_MAX_MS ? "warn" : undefined}
        />
        <Tile label="Tasks" value={t.count} sub={`queue wait p95 ${fmtMs(t.queueWaitMs.p95)}`} />
      </div>

      <div class="grid cols-2">
        <Card title="Task outcomes">
          <StackBar
            label="Task outcomes"
            parts={OUTCOMES.map((o) => ({ key: o.key, label: o.label, value: t.byOutcome[o.key] ?? 0, cls: `c-${o.key}` }))}
          />
          <dl class="kv" style={{ marginTop: "14px" }}>
            <dt>Duration p50 / p95</dt>
            <dd>
              {fmtMs(t.durationMs.p50)} / {fmtMs(t.durationMs.p95)}
            </dd>
            <dt>Guard refusals</dt>
            <dd>{t.guardRefusals}</dd>
          </dl>
        </Card>
        <Card title="Tokens">
          <TokenBreakdown t={t.tokens} />
        </Card>
      </div>

      <div class="grid cols-2">
        <Card title="First reply over time">
          <TimeChart
            label="First-reply latency per task, seconds"
            yFmt={(v) => `${Math.round(v * 10) / 10}s`}
            refLine={{ y: FIRST_REPLY_P50_MAX_MS / 1000, label: `${FIRST_REPLY_P50_MAX_MS / 1000}s target` }}
            series={[{ name: "First reply", cls: "s1", points: frSeries }]}
            empty={tasksError ?? (tasks === null ? "Loading…" : "No replies in this window.")}
          />
        </Card>
        <Card title="Turns per task">
          <TimeChart
            label="Turns used per task"
            yFmt={(v) => String(Math.round(v))}
            refLine={{ y: NEAR_CAP_TURNS, label: `near cap (${NEAR_CAP_TURNS})` }}
            series={[{ name: "Turns", cls: "s2", points: turnSeries }]}
            empty={tasksError ?? (tasks === null ? "Loading…" : "No finished tasks in this window.")}
          />
        </Card>
      </div>

      <TaskTable rows={rows} />
    </div>
  );
}

function Flags({ flags, taskCount }: { flags: ReportResponse["flags"]; taskCount: number }) {
  const sorted = [...flags].sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
  const [all, setAll] = useState(false);
  const LIMIT = 4;
  const warns = sorted.filter((f) => f.level === "warn").length;
  if (sorted.length === 0) {
    return (
      <div class="alert good">
        <ICheck />
        <div>{taskCount === 0 ? "No tasks in this window yet — nothing to flag." : "No flags — everything is inside its thresholds."}</div>
      </div>
    );
  }
  return (
    <Card title={<>Flags <span class="dim tnum">{sorted.length}</span></>} actions={warns > 0 ? <Badge tone="warn">{warns} warning{warns === 1 ? "" : "s"}</Badge> : undefined}>
      <div class="stack tight" role="list">
        {(all ? sorted : sorted.slice(0, LIMIT)).map((f, i) => (
          <div class={`flag ${f.level}`} key={i} role="listitem">
            {f.level === "warn" ? <IAlert aria-label="Warning" /> : <IInfo aria-label="Info" />}
            <div class="grow" style={{ overflowWrap: "anywhere" }}>
              {f.message}
              <code>{f.code}</code>
            </div>
          </div>
        ))}
      </div>
      {sorted.length > LIMIT && (
        <button class="btn sm ghost block" style={{ marginTop: "8px" }} onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${sorted.length} flags`}
        </button>
      )}
    </Card>
  );
}

function TokenBreakdown({ t }: { t: { input: number; output: number; cacheRead: number; cacheCreate: number } }) {
  const rows = [
    { label: "Cache read", v: t.cacheRead, cls: "c-s3" },
    { label: "Cache write", v: t.cacheCreate, cls: "c-s2" },
    { label: "Uncached input", v: t.input, cls: "c-s1" },
  ];
  const total = rows.reduce((n, r) => n + r.v, 0);
  return (
    <div>
      <StackBar label="Input tokens" parts={rows.map((r) => ({ key: r.label, label: r.label, value: r.v, cls: r.cls }))} />
      <dl class="kv" style={{ marginTop: "14px" }}>
        <dt>Input total</dt>
        <dd>{fmtNum(total)}</dd>
        <dt>Output</dt>
        <dd>{fmtNum(t.output)}</dd>
      </dl>
    </div>
  );
}

function TaskTable({ rows }: { rows: TaskRow[] }) {
  const [limit, setLimit] = useState(25);
  const shown = rows.slice(0, limit);
  return (
    <Card title={<>Task history <span class="dim tnum">{rows.length}</span></>} flush>
      {rows.length === 0 ? (
        <p class="muted" style={{ padding: "0 16px 16px" }}>No tasks in this window.</p>
      ) : (
        <>
          <div class="table-wrap only-desktop">
            <table class="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Request</th>
                  <th>Outcome</th>
                  <th class="num">Turns</th>
                  <th class="num">First reply</th>
                  <th class="num">Duration</th>
                  <th class="num">Tools</th>
                  <th class="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => {
                  const e = x.end;
                  const om = e ? outcomeMeta(e.outcome) : null;
                  return (
                    <tr key={x.id} class={e && (e.outcome === "failed" || e.outcome === "max_turns") ? "row-bad" : e && e.turns >= NEAR_CAP_TURNS ? "row-warn" : ""}>
                      <td class="nowrap tnum">{fmtWhen(x.at)}</td>
                      <td style={{ maxWidth: "320px" }}>
                        <div class="ellipsis" title={x.start?.request}>{x.start?.request ?? <span class="dim">—</span>}</div>
                        {x.start?.player && <div class="small dim">{x.start.player} · {x.start.route}</div>}
                      </td>
                      <td>{om ? <Badge tone={om.tone}>{om.label}</Badge> : <Badge tone="info">running</Badge>}</td>
                      <td class="num">{e?.turns ?? "—"}</td>
                      <td class="num">{fmtMs(e?.firstReplyMs)}</td>
                      <td class="num">{fmtMs(e?.durationMs)}</td>
                      <td class="num">
                        {e ? e.toolCalls : "—"}
                        {e && e.toolFailures > 0 && <span style={{ color: "var(--bad-ink)" }}> ({e.toolFailures}✗)</span>}
                      </td>
                      <td class="num">{fmtUsd(e?.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div class="list only-mobile">
            {shown.map((x) => {
              const e = x.end;
              const om = e ? outcomeMeta(e.outcome) : null;
              return (
                <div class={`list-item ${e && (e.outcome === "failed" || e.outcome === "max_turns") ? "bad" : ""}`} key={x.id} style={{ alignItems: "flex-start" }}>
                  <div class="grow">
                    <div class="row between">
                      <span class="ellipsis" style={{ fontWeight: 600 }}>{x.start?.request ?? "—"}</span>
                      {om ? <Badge tone={om.tone}>{om.label}</Badge> : <Badge tone="info">running</Badge>}
                    </div>
                    <div class="small muted tnum" style={{ marginTop: "2px" }}>
                      {fmtWhen(x.at)}
                      {x.start?.player ? ` · ${x.start.player}` : ""}
                      {e ? ` · ${e.turns} turns · reply ${fmtMs(e.firstReplyMs)} · ${fmtMs(e.durationMs)} · ${fmtUsd(e.costUsd)}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {rows.length > limit && (
            <div style={{ padding: "12px 16px" }}>
              <button class="btn sm block" onClick={() => setLimit(limit + 50)}>
                Show more ({rows.length - limit})
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
