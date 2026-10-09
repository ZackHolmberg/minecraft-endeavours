import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ActionDef, JobSummary, StatusResponse } from "../../../shared/api.js";
import { useStore } from "../lib/store.js";
import { status } from "../lib/status.js";
import { useChannel, useFetch, useNow } from "../lib/hooks.js";
import { runAction, ACTION_LABEL } from "../lib/actions.js";
import { href } from "../lib/router.js";
import { fmtAgo, fmtDuration, fmtMs } from "../lib/format.js";
import { Alert, Badge, Card, ErrorState, Meter, Skeleton, type Tone } from "../components/ui.js";
import { IBot, ICpu, IPlay, IRestart, ISave, IServer, IStop, IArchive, IHeart, IMap } from "../components/icons.js";

type ServerState = StatusResponse["server"]["state"];

export function serverTone(s: StatusResponse["server"]): { tone: Tone; label: string } {
  const map: Record<ServerState, { tone: Tone; label: string }> = {
    running: { tone: "good", label: "Running" },
    starting: { tone: "warn", label: "Starting" },
    stopped: { tone: "neutral", label: "Stopped" },
    unhealthy: { tone: "bad", label: "Unhealthy" },
    unknown: { tone: "neutral", label: "Unknown" },
  };
  const m = map[s.state];
  if (s.state === "running" && !s.reachable) return { tone: "warn", label: "Running · not reachable" };
  return m;
}

function heroTone(t: Tone): string {
  return t === "good" ? "good" : t === "warn" ? "warn" : t === "bad" ? "bad" : "";
}

export function Overview() {
  const st = useStore(status);
  const now = useNow(1000);
  const d = st.data;
  const stale = d && now - st.receivedAt > 15_000;

  if (!d) {
    if (st.error) return <ErrorState error={st.error} />;
    return (
      <div class="grid cols-3">
        {[0, 1, 2].map((i) => (
          <div class="card" key={i}>
            <Skeleton lines={4} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div class="stack overview">
      {stale && (
        <Alert tone="warn" title="Status may be out of date">
          Last update {fmtAgo(st.receivedAt, now)}. {st.error ?? "Reconnecting…"}
        </Alert>
      )}
      <div class="grid cols-3 ov-status">
        <div class="ov-server"><ServerCard d={d} now={now} /></div>
        <div class="ov-bot"><BotCard d={d} now={now} /></div>
        <div class="ov-host"><HostCard d={d} /></div>
      </div>
      {d.activeJobs.length > 0 && <div class="ov-jobs"><ActiveJobs jobs={d.activeJobs} now={now} /></div>}
      <div class="ov-controls"><Controls d={d} /></div>
    </div>
  );
}

function ServerCard({ d, now }: { d: StatusResponse; now: number }) {
  const s = d.server;
  const t = serverTone(s);
  return (
    <Card>
      <div class="hero">
        <div class={`hero-icon ${heroTone(t.tone)}`}>
          <IServer />
        </div>
        <div class="grow">
          <div class="hero-label">Minecraft server</div>
          <div class="hero-value">{t.label}</div>
          <div class="small muted">{s.since && s.state !== "stopped" ? `Up ${fmtDuration(now - s.since)}` : s.state === "stopped" ? "Not running" : "—"}</div>
        </div>
      </div>
      <div class="divider" style={{ margin: "14px 0" }} />
      <dl class="kv">
        <dt>Players</dt>
        <dd>
          {s.players ? (
            <strong class="tnum">
              {s.players.online}
              {s.players.max !== null ? ` / ${s.players.max}` : ""}
            </strong>
          ) : (
            "—"
          )}
        </dd>
        <dt>Version</dt>
        <dd>{s.version ?? "—"}</dd>
        <dt>Port 25565</dt>
        <dd>{s.reachable ? <Badge tone="good">Accepting</Badge> : <Badge tone={s.state === "stopped" ? "neutral" : "warn"}>Closed</Badge>}</dd>
        <dt>DuckDNS</dt>
        <dd>
          <Badge tone={d.duckdns.state === "running" ? "good" : d.duckdns.state === "stopped" ? "bad" : "neutral"}>{d.duckdns.state}</Badge>
        </dd>
      </dl>
      {s.players && s.players.names.length > 0 && (
        <div class="pill-list" style={{ marginTop: "12px" }}>
          {s.players.names.map((n) => (
            <span class="pill" key={n}>
              {n}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function BotCard({ d, now }: { d: StatusResponse; now: number }) {
  const b = d.bot;
  const bots = b.bots ?? [];
  const first = bots[0];
  const conn = first?.connection;
  const tone: Tone = !b.running ? "neutral" : conn === "connected" ? "good" : conn ? "warn" : "warn";
  const label = !b.running ? "Stopped" : !first ? "Running · no snapshot" : conn === "connected" ? "In game" : conn ?? "Starting";
  return (
    <Card>
      <a class="hero" href={href("/bot")} style={{ textDecoration: "none", color: "inherit" }}>
        <div class={`hero-icon ${heroTone(tone)}`}>
          <IBot />
        </div>
        <div class="grow">
          <div class="hero-label">AI bot{bots.length === 1 ? ` · ${first!.username}` : ""}</div>
          <div class="hero-value" style={{ textTransform: "capitalize" }}>{label}</div>
          <div class="small muted">{b.running && b.since ? `Up ${fmtDuration(now - b.since)} · pid ${b.pid ?? "?"}` : "Orchestrator not running"}</div>
        </div>
      </a>
      <div class="divider" style={{ margin: "14px 0" }} />
      {bots.length === 0 ? (
        <p class="small muted">{b.running ? "Waiting for the bot to publish a snapshot…" : "Start the bot to see its live state."}</p>
      ) : (
        <div class="stack">
          {bots.map((x) => (
            <div class="stack tight" key={x.username}>
              {bots.length > 1 && <strong>{x.username}</strong>}
              <div class="meter-row">
                <span class="muted"><IHeart width={14} height={14} /> HP</span>
                <Meter value={x.health ?? 0} max={20} tone={(x.health ?? 0) <= 6 ? "bad" : (x.health ?? 0) <= 12 ? "warn" : "good"} label="Health" />
                <span class="tnum">{x.health ?? "—"}/20</span>
              </div>
              <div class="meter-row">
                <span class="muted">Food</span>
                <Meter value={x.food ?? 0} max={20} tone={(x.food ?? 0) <= 6 ? "bad" : (x.food ?? 0) <= 12 ? "warn" : "good"} label="Food" />
                <span class="tnum">{x.food ?? "—"}/20</span>
              </div>
              <dl class="kv" style={{ marginTop: "4px" }}>
                <dt>Task</dt>
                <dd class="ellipsis">{x.currentTask ?? <span class="dim">Idle</span>}</dd>
                <dt>Tool</dt>
                <dd>{x.currentTool ? <code>{x.currentTool}</code> : <span class="dim">—</span>}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HostCard({ d }: { d: StatusResponse }) {
  const h = d.host;
  const used = h.totalMemMb - h.freeMemMb;
  const memPct = h.totalMemMb > 0 ? used / h.totalMemMb : 0;
  return (
    <Card>
      <div class="hero">
        <div class="hero-icon">
          <ICpu />
        </div>
        <div class="grow">
          <div class="hero-label">Host</div>
          <div class="hero-value tnum">{h.loadAvg1m.toFixed(2)}</div>
          <div class="small muted">1-minute load average</div>
        </div>
      </div>
      <div class="divider" style={{ margin: "14px 0" }} />
      <div class="stack tight">
        <div class="row between small">
          <span class="muted">Memory</span>
          <span class="tnum">
            {(used / 1024).toFixed(1)} / {(h.totalMemMb / 1024).toFixed(1)} GB
          </span>
        </div>
        <Meter value={used} max={h.totalMemMb} tone={memPct > 0.9 ? "bad" : memPct > 0.75 ? "warn" : "info"} label="Memory used" />
        <dl class="kv" style={{ marginTop: "8px" }}>
          <dt>Disk free</dt>
          <dd>{h.diskFreeGb !== null ? `${h.diskFreeGb.toFixed(1)} GB` : "—"}</dd>
          <dt>Panel</dt>
          <dd>v{d.panel.version}</dd>
        </dl>
      </div>
    </Card>
  );
}

function ActiveJobs({ jobs, now }: { jobs: JobSummary[]; now: number }) {
  return (
    <Card title="Running now" actions={<a class="btn sm ghost" href={href("/jobs")}>All jobs</a>}>
      <div class="stack">
        {jobs.map((j) => (
          <JobTail key={j.id} job={j} now={now} />
        ))}
      </div>
    </Card>
  );
}

function JobTail({ job, now }: { job: JobSummary; now: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useChannel(`job:${job.id}`, (m) => {
    if (m.type === "job_output" && m.jobId === job.id) setLines((l) => [...l, ...m.lines].slice(-6));
  });
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <div class="stack tight">
      <div class="row">
        <span class="spinner" aria-hidden="true" />
        <strong class="grow">{ACTION_LABEL[job.action]}</strong>
        <span class="small muted tnum">{fmtMs(now - job.startedAt)}</span>
        <a class="btn sm" href={href(`/jobs/${job.id}`)}>Output</a>
      </div>
      <div class="terminal term-short" ref={ref} aria-live="off">
        {lines.length === 0 ? <div class="ln dim">Waiting for output…</div> : lines.map((l, i) => <div class="ln" key={i}>{l}</div>)}
      </div>
    </div>
  );
}

const GROUPS: Array<{ group: ActionDef["group"]; title: string }> = [
  { group: "server", title: "Server" },
  { group: "bot", title: "Bot" },
  { group: "world", title: "World" },
];

function actionIcon(id: string) {
  if (id.endsWith(".start")) return <IPlay />;
  if (id.endsWith(".stop")) return <IStop />;
  if (id.endsWith(".restart")) return <IRestart />;
  if (id === "backup.run") return <IArchive />;
  return <ISave />;
}

function Controls({ d }: { d: StatusResponse }) {
  const actions = useFetch<ActionDef[]>("/api/actions");
  const [pending, setPending] = useState<string | null>(null);
  // Availability depends on server/bot state; refetch whenever that changes.
  const key = `${d.server.state}|${d.server.reachable}|${d.bot.running}|${d.activeJobs.map((j) => j.id).join(",")}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    actions.reload();
  }, [key]);

  const busyGroups = useMemo(() => {
    const s = new Set<string>();
    for (const j of d.activeJobs) {
      if (j.action === "world.new") GROUPS.forEach((g) => s.add(g.group)); // exclusive across every group
      else s.add(j.action.split(".")[0] === "backup" ? "world" : j.action.split(".")[0]!);
    }
    return s;
  }, [d.activeJobs]);

  return (
    <div class="grid cols-3">
      {GROUPS.map((g) => {
        // world.new takes a seed + typed confirmation, so it lives on the Backups page.
        const defs = (actions.data ?? []).filter((a) => a.group === g.group && a.id !== "world.new");
        const reasons = [...new Set(defs.filter((a) => !a.available && a.unavailableReason).map((a) => a.unavailableReason!))];
        return (
          <Card key={g.group} title={g.title} actions={busyGroups.has(g.group) ? <Badge tone="info">Job running</Badge> : undefined}>
            {actions.data === null ? (
              actions.error ? <ErrorState error={actions.error} onRetry={actions.reload} /> : <Skeleton lines={2} />
            ) : (
              <>
                <div class="action-grid" style={g.group === "world" ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } : undefined}>
                  {defs.map((a) => (
                    <button
                      key={a.id}
                      class={`btn ${a.id.endsWith(".stop") ? "danger" : a.id.endsWith(".start") ? "primary" : ""}`}
                      disabled={!a.available || pending !== null}
                      title={a.available ? a.description : a.unavailableReason ?? undefined}
                      aria-describedby={!a.available && a.unavailableReason ? `why-${g.group}` : undefined}
                      onClick={async () => {
                        setPending(a.id);
                        try {
                          await runAction(a);
                          actions.reload();
                        } finally {
                          setPending(null);
                        }
                      }}
                    >
                      {pending === a.id ? <span class="spinner" aria-hidden="true" /> : actionIcon(a.id)}
                      {a.label}
                    </button>
                  ))}
                </div>
                {reasons.length > 0 && (
                  <p class="action-reason" id={`why-${g.group}`}>
                    {reasons.join(" · ")}
                  </p>
                )}
                {g.group === "world" && (
                  <a class="btn sm ghost" href={href("/backups")} style={{ marginTop: "8px" }}>
                    <IMap /> New world…
                  </a>
                )}
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}
