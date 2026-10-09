import { useEffect, useRef, useState } from "preact/hooks";
import type { JobDetail, JobSummary } from "../../../shared/api.js";
import { useChannel, useFetch, useNow } from "../lib/hooks.js";
import { ACTION_LABEL } from "../lib/actions.js";
import { href } from "../lib/router.js";
import { fmtMs, fmtWhen } from "../lib/format.js";
import { Badge, Card, Empty, Load } from "../components/ui.js";
import { IArrowLeft, IDown, IJobs } from "../components/icons.js";
import { lineClass } from "./Logs.js";

export function JobBadge({ j }: { j: Pick<JobSummary, "state" | "exitCode"> }) {
  if (j.state === "running") return <Badge tone="info">Running</Badge>;
  if (j.state === "succeeded") return <Badge tone="good">Succeeded</Badge>;
  return <Badge tone="bad">Failed{j.exitCode !== null ? ` (${j.exitCode})` : ""}</Badge>;
}

export function Jobs({ jobId }: { jobId: string | null }) {
  return jobId ? <JobView id={jobId} /> : <JobList />;
}

function JobList() {
  const jobs = useFetch<JobSummary[]>("/api/jobs", { interval: 5000 });
  const now = useNow(1000);
  return (
    <Card title="Job history" flush actions={<span class="small dim" style={{ paddingRight: "16px" }}>Last 50</span>}>
      <Load {...jobs}>
        {(list) =>
          list.length === 0 ? (
            <Empty icon={<IJobs />} title="No jobs yet">Server and bot actions you run from the overview show up here with their full output.</Empty>
          ) : (
            <div class="list">
              {list.map((j) => (
                <a class={`list-item ${j.state === "failed" ? "bad" : ""}`} key={j.id} href={href(`/jobs/${j.id}`)}>
                  <div class="grow">
                    <div style={{ fontWeight: 600 }}>{ACTION_LABEL[j.action] ?? j.action}</div>
                    <div class="small muted">
                      {fmtWhen(j.startedAt)} · {j.startedBy} · {fmtMs((j.endedAt ?? now) - j.startedAt)}
                    </div>
                  </div>
                  <JobBadge j={j} />
                </a>
              ))}
            </div>
          )
        }
      </Load>
    </Card>
  );
}

function JobView({ id }: { id: string }) {
  const job = useFetch<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
  const now = useNow(1000);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useChannel(`job:${id}`, (m) => {
    if (m.type === "job_output" && m.jobId === id) job.setData((p) => (p ? { ...p, output: [...p.output, ...m.lines].slice(-4000) } : p!));
    if (m.type === "job_state" && m.job.id === id) job.setData((p) => (p ? { ...p, ...m.job } : p!));
  });

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.data?.output.length, follow]);

  return (
    <div class="stack">
      <div>
        <a class="btn sm ghost" href={href("/jobs")}>
          <IArrowLeft /> All jobs
        </a>
      </div>
      <Load {...job} lines={6}>
        {(j) => (
          <Card
            title={ACTION_LABEL[j.action] ?? j.action}
            actions={<JobBadge j={j} />}
          >
            <div class="row wrap small muted" style={{ marginBottom: "12px", gap: "4px 16px" }}>
              <span>Started {fmtWhen(j.startedAt)}</span>
              <span>by {j.startedBy}</span>
              <span class="tnum">{j.state === "running" ? `running ${fmtMs(now - j.startedAt)}` : `took ${fmtMs((j.endedAt ?? now) - j.startedAt)}`}</span>
              {j.exitCode !== null && <span>exit {j.exitCode}</span>}
            </div>
            <div
              class="terminal term-tall"
              ref={ref}
              role="log"
              aria-label="Job output"
              onScroll={(e) => {
                const el = e.currentTarget as HTMLDivElement;
                setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
              }}
            >
              {j.output.length === 0 ? (
                <div class="ln dim">{j.state === "running" ? "Waiting for output…" : "No output."}</div>
              ) : (
                j.output.map((l, i) => (
                  <div class={`ln ${lineClass(l)}`} key={i}>
                    {l}
                  </div>
                ))
              )}
              {j.state === "running" && <div class="ln dim"><span class="spinner" style={{ width: "10px", height: "10px" }} /> running…</div>}
            </div>
            {!follow && (
              <button class="btn sm" style={{ marginTop: "8px" }} onClick={() => setFollow(true)}>
                <IDown /> Jump to latest
              </button>
            )}
          </Card>
        )}
      </Load>
    </div>
  );
}
