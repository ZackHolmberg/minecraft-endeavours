import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { SkillStats, TelemetryAggregate } from "../../../../../observability/telemetry-types.js";
import { SKILL_MIN_CALLS, SKILL_SUCCESS_MIN } from "../../../../../report/flags.js";
import { fmtMs, fmtPct, fmtPos, fmtWhen } from "../../lib/format.js";
import { Badge, Card, Empty, Tile } from "../../components/ui.js";
import { HBars } from "../../components/charts.js";
import { IZap } from "../../components/icons.js";

function rateTone(s: SkillStats): "bad" | "warn" | "good" | undefined {
  if (s.successRate === null) return undefined;
  if (s.successRate < SKILL_SUCCESS_MIN) return s.calls >= SKILL_MIN_CALLS ? "bad" : "warn";
  if (s.successRate < 0.85) return "warn";
  return "good";
}

export function SkillsPanel({ agg }: { agg: TelemetryAggregate }) {
  // Worst success rate first; skills with no judged calls sink to the bottom.
  const skills = [...agg.skills].sort((a, b) => (a.successRate ?? 2) - (b.successRate ?? 2) || b.calls - a.calls);
  const [open, setOpen] = useState<string | null>(null);
  if (skills.length === 0) return <Card><Empty icon={<IZap />} title="No skill calls in this window" /></Card>;
  const totalCalls = skills.reduce((n, s) => n + s.calls, 0);
  const totalFail = skills.reduce((n, s) => n + s.failed, 0);
  const timeouts = skills.reduce((n, s) => n + s.timedOut, 0);
  return (
    <div class="stack">
      <div class="grid tiles">
        <Tile label="Skill calls" value={totalCalls} />
        <Tile label="Failed" value={totalFail} sub={fmtPct(totalCalls ? totalFail / totalCalls : null)} />
        <Tile label="Watchdog timeouts" value={timeouts} tone={timeouts > 0 ? "warn" : undefined} />
        <Tile label="Unreliable skills" value={skills.filter((s) => rateTone(s) === "bad").length} sub={`<${fmtPct(SKILL_SUCCESS_MIN)} over ≥${SKILL_MIN_CALLS} calls`} />
      </div>
      <Card title="Skills · worst success rate first" flush>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Skill</th>
                <th class="num">Success</th>
                <th class="num">Calls</th>
                <th class="num only-desktop">Failed</th>
                <th class="num only-desktop">Cancelled</th>
                <th class="num only-desktop">Timeouts</th>
                <th class="num">p50</th>
                <th class="num only-desktop">p95</th>
                <th class="only-desktop">Top failure</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => {
                const tone = rateTone(s);
                const top = s.topFailures[0];
                const isOpen = open === s.skill;
                return (
                  <Fragment key={s.skill}>
                    <tr
                      class={`clickable ${tone === "bad" ? "row-bad" : tone === "warn" ? "row-warn" : ""}`}
                      onClick={() => setOpen(isOpen ? null : s.skill)}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(isOpen ? null : s.skill))}
                    >
                      <td class="mono">{s.skill}</td>
                      <td class="num">
                        {tone ? <Badge tone={tone} plain>{fmtPct(s.successRate)}</Badge> : fmtPct(s.successRate)}
                      </td>
                      <td class="num">{s.calls}</td>
                      <td class="num only-desktop">{s.failed || <span class="dim">0</span>}</td>
                      <td class="num only-desktop">{s.cancelled || <span class="dim">0</span>}</td>
                      <td class="num only-desktop">{s.timedOut ? <strong style={{ color: "var(--warn-ink)" }}>{s.timedOut}</strong> : <span class="dim">0</span>}</td>
                      <td class="num">{fmtMs(s.durationMs.p50)}</td>
                      <td class="num only-desktop">{fmtMs(s.durationMs.p95)}</td>
                      <td class="only-desktop small" style={{ maxWidth: "280px" }}>
                        {top ? <span class="ellipsis" style={{ display: "block" }} title={top.message}>{top.message} <span class="dim">×{top.count}</span></span> : <span class="dim">—</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${s.skill}-detail`}>
                        <td colSpan={9} style={{ background: "var(--surface-2)" }}>
                          <div class="small stack tight">
                            <div class="muted">
                              {s.ok} ok · {s.failed} failed · {s.cancelled} cancelled · {s.timedOut} timed out · max {fmtMs(s.durationMs.max)}
                            </div>
                            {s.topFailures.length === 0 ? (
                              <div class="dim">No failures.</div>
                            ) : (
                              s.topFailures.map((f, i) => (
                                <div key={i}>
                                  <span class="mono">{f.message}</span> <span class="dim">×{f.count}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p class="small dim">Tap a row for failure details. Success = ok ÷ (calls − cancelled).</p>
    </div>
  );
}

const NAV_TONE: Record<string, "good" | "bad" | "warn" | undefined> = {
  arrived: "good",
  no_path: "bad",
  stuck: "bad",
  timeout: "bad",
  error: "bad",
  cancelled: undefined,
};

export function MovementPanel({ agg }: { agg: TelemetryAggregate }) {
  const n = agg.nav;
  const arrived = n.byResult.arrived ?? 0;
  const judged = n.count - (n.byResult.cancelled ?? 0);
  const navRows = Object.entries(n.byResult)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k.replace("_", " "), value: v, tone: NAV_TONE[k] }));
  return (
    <div class="stack">
      <div class="grid tiles">
        <Tile label="Nav success" value={fmtPct(judged > 0 ? arrived / judged : null)} sub={`${arrived}/${judged} arrived`} tone={judged >= 5 && arrived / judged < 0.7 ? "warn" : undefined} />
        <Tile label="Nav time p50" value={fmtMs(n.durationMs.p50)} sub={`p95 ${fmtMs(n.durationMs.p95)}`} />
        <Tile label="Doors" value={agg.doors.opened} unit="opened" sub={`${agg.doors.closed} closed${agg.doors.opened > agg.doors.closed ? ` · ${agg.doors.opened - agg.doors.closed} left open` : ""}`} />
        <Tile label="Pillar" value={`${agg.pillar.ok}/${agg.pillar.runs}`} unit="ok" sub={`${agg.pillar.placed} blocks placed`} />
        <Tile label="Structure guard" value={agg.structureSkips} sub="player blocks left alone" />
        <Tile label="Deaths" value={agg.deaths} tone={agg.deaths > 0 ? "bad" : undefined} />
      </div>
      <div class="grid cols-2">
        <Card title="Navigation results">
          <HBars rows={navRows} />
        </Card>
        <Card title="Reflexes">
          <HBars
            rows={(["defend", "eat", "armor", "look"] as const).map((k) => ({ label: k, value: agg.reflexes[k] ?? 0 }))}
          />
        </Card>
      </div>
      <Card title="Problem spots" flush>
        {n.problemSpots.length === 0 ? (
          <p class="muted" style={{ padding: "0 16px 16px" }}>No stuck / no-path / timeout spots in this window.</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {n.problemSpots.map((p, i) => (
                  <tr key={i}>
                    <td class="nowrap tnum">{fmtWhen(p.at)}</td>
                    <td>{p.label}</td>
                    <td><Badge tone="bad" plain>{p.result.replace("_", " ")}</Badge></td>
                    <td class="mono nowrap">{fmtPos(p.from)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div class="grid cols-2">
        <Card title="Chat">
          <dl class="kv">
            <dt>Inbound</dt>
            <dd>{agg.chat.inbound}</dd>
            <dt>Routed to bot</dt>
            <dd>{agg.chat.routed}</dd>
            <dt>Bot messages</dt>
            <dd>{agg.chat.outbound}</dd>
            <dt>Stop requests</dt>
            <dd>{agg.chat.stops}</dd>
          </dl>
        </Card>
        <Card title="Process health">
          <dl class="kv">
            <dt>Disconnects</dt>
            <dd>{agg.health.disconnects ? <Badge tone="warn" plain>{agg.health.disconnects}</Badge> : 0}</dd>
            <dt>Max loop lag</dt>
            <dd>{agg.health.maxLoopLagMs !== null ? fmtMs(agg.health.maxLoopLagMs) : "—"}</dd>
            <dt>Rate-limit events</dt>
            <dd>{agg.health.rateLimitEvents}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
