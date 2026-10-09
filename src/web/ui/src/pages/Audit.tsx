import { useMemo, useState } from "preact/hooks";
import type { AuditEntry } from "../../../shared/api.js";
import { useFetch } from "../lib/hooks.js";
import { fmtWhen } from "../lib/format.js";
import { Badge, Card, Empty, Load, type Tone } from "../components/ui.js";
import { IShield } from "../components/icons.js";

const KIND: Record<AuditEntry["kind"], { label: string; tone: Tone }> = {
  login_ok: { label: "Sign-in", tone: "good" },
  login_fail: { label: "Failed sign-in", tone: "bad" },
  lockout: { label: "Lockout", tone: "bad" },
  logout: { label: "Sign-out", tone: "neutral" },
  session_revoked: { label: "Sessions revoked", tone: "warn" },
  action: { label: "Action", tone: "info" },
  console: { label: "Console", tone: "info" },
  players: { label: "Players", tone: "info" },
};

type Filter = "all" | "auth" | "failures" | "action" | "console" | "players";
const FILTERS: Array<{ v: Filter; label: string }> = [
  { v: "all", label: "All" },
  { v: "failures", label: "Failures" },
  { v: "auth", label: "Auth" },
  { v: "action", label: "Actions" },
  { v: "console", label: "Console" },
  { v: "players", label: "Players" },
];

function pass(e: AuditEntry, f: Filter): boolean {
  switch (f) {
    case "all": return true;
    case "failures": return !e.ok || e.kind === "login_fail" || e.kind === "lockout";
    case "auth": return ["login_ok", "login_fail", "lockout", "logout", "session_revoked"].includes(e.kind);
    default: return e.kind === f;
  }
}

const isAlarm = (e: AuditEntry) => e.kind === "login_fail" || e.kind === "lockout";

export function Audit() {
  const a = useFetch<AuditEntry[]>("/api/audit?limit=200", { interval: 20_000 });
  const [f, setF] = useState<Filter>("all");
  const fails24 = useMemo(() => (a.data ?? []).filter((e) => isAlarm(e) && Date.now() - e.at < 86400_000).length, [a.data]);
  return (
    <div class="stack">
      <div class="row wrap between">
        <div class="chips" role="group" aria-label="Filter">
          {FILTERS.map((x) => (
            <button key={x.v} class="chip" style={{ fontFamily: "var(--font)" }} aria-pressed={f === x.v} onClick={() => setF(x.v)}>
              {x.label}
            </button>
          ))}
        </div>
        {fails24 > 0 && <Badge tone="bad">{fails24} failed sign-in{fails24 === 1 ? "" : "s"} in 24h</Badge>}
      </div>
      <Card flush>
        <Load {...a} lines={8}>
          {(list) => {
            const rows = list.filter((e) => pass(e, f));
            if (rows.length === 0) return <Empty icon={<IShield />} title={list.length === 0 ? "No audit entries yet" : "Nothing matches this filter"} />;
            return (
              <>
                <div class="table-wrap only-desktop">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        <th>Detail</th>
                        <th>User</th>
                        <th>IP</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e, i) => (
                        <tr key={i} class={isAlarm(e) ? "row-bad" : !e.ok ? "row-warn" : ""}>
                          <td class="nowrap tnum">{fmtWhen(e.at)}</td>
                          <td class="nowrap"><Badge tone={KIND[e.kind].tone} plain>{KIND[e.kind].label}</Badge></td>
                          <td class="mono" style={{ wordBreak: "break-word" }}>{e.detail}</td>
                          <td>{e.user ?? <span class="dim">—</span>}</td>
                          <td class="mono nowrap">{e.ip}</td>
                          <td>{e.ok ? <Badge tone="good">ok</Badge> : <Badge tone="bad">failed</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div class="list only-mobile">
                  {rows.map((e, i) => (
                    <div key={i} class={`list-item ${isAlarm(e) ? "bad" : ""}`} style={{ alignItems: "flex-start" }}>
                      <div class="grow stack tight" style={{ gap: "3px" }}>
                        <div class="row between">
                          <Badge tone={KIND[e.kind].tone} plain>{KIND[e.kind].label}</Badge>
                          <span class="small dim tnum">{fmtWhen(e.at)}</span>
                        </div>
                        <div class="mono small" style={{ wordBreak: "break-word" }}>{e.detail}</div>
                        <div class="small dim">
                          {e.user ?? "anonymous"} · <span class="mono">{e.ip}</span> · {e.ok ? "ok" : <strong style={{ color: "var(--bad-ink)" }}>failed</strong>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            );
          }}
        </Load>
      </Card>
    </div>
  );
}
