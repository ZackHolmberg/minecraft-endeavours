import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { TelemetryEvent } from "../../../../../observability/telemetry-types.js";
import { api, errorMessage, HttpError } from "../../lib/api.js";
import { useChannel, useNow } from "../../lib/hooks.js";
import { fmtAgo, fmtMs, fmtPos, fmtTime } from "../../lib/format.js";
import { Card, Empty, ErrorState, Skeleton } from "../../components/ui.js";
import { IAlert, IChat, ICheck, IDoor, IHeart, IMap, ISkull, IWifiOff, IZap, IClock, IBot, IX } from "../../components/icons.js";

const NOTABLE_KINDS = [
  "task_start", "task_end", "guard_refusal", "skill", "nav", "door", "pillar", "structure_skip",
  "reflex", "hurt", "death", "connection", "loop_lag", "rate_limit",
];
const MAX = 80;

/** Same rule the snapshot uses for `notable`. */
function isNotable(e: TelemetryEvent): boolean {
  if (e.kind === "reflex") return e.reflex !== "look";
  if (e.kind === "skill") return !e.ok;
  if (e.kind === "step") return !e.ok;
  if (e.kind === "chat_in" || e.kind === "chat_out") return false;
  return true;
}

type Tone = "good" | "warn" | "bad" | "info" | "";
interface Described {
  icon: ComponentChildren;
  tone: Tone;
  title: ComponentChildren;
  detail?: ComponentChildren;
}

export function describe(e: TelemetryEvent): Described {
  switch (e.kind) {
    case "task_start":
      return { icon: <IChat />, tone: "info", title: <>Task started: “{e.request}”</>, detail: `${e.player ?? "orchestrator"} · ${e.route}${e.contextBuildMs === null && e.contextInjected !== false ? " · context timed out" : ""}` };
    case "task_end": {
      const tone: Tone = e.outcome === "finished" ? "good" : e.outcome === "stopped" ? "" : e.outcome === "failed" || e.outcome === "max_turns" ? "bad" : "warn";
      return { icon: e.outcome === "finished" ? <ICheck /> : <IX />, tone, title: `Task ${e.outcome.replace("_", " ")}`, detail: `${e.turns} turns · ${fmtMs(e.durationMs)} · reply ${fmtMs(e.firstReplyMs)} · ${e.toolCalls} tools${e.toolFailures ? ` (${e.toolFailures} failed)` : ""}` };
    }
    case "guard_refusal":
      return { icon: <IAlert />, tone: "warn", title: <>Guard refused repeat <code>{e.tool}</code></>, detail: e.args };
    case "skill":
      return { icon: <IZap />, tone: e.timedOut ? "warn" : "bad", title: <><code>{e.skill}</code> {e.timedOut ? "timed out" : e.cancelled ? "cancelled" : "failed"}</>, detail: e.message };
    case "nav":
      return { icon: <IMap />, tone: e.result === "arrived" ? "good" : e.result === "cancelled" ? "" : "bad", title: `Nav to ${e.label}: ${e.result.replace("_", " ")}`, detail: `${Math.round(e.distance)} blocks · ${fmtMs(e.durationMs)} · from ${fmtPos(e.from)}` };
    case "door":
      return { icon: <IDoor />, tone: "", title: `${e.action === "open" ? "Opened" : "Closed"} ${e.block.replace(/_/g, " ")}`, detail: fmtPos(e.pos) };
    case "pillar":
      return { icon: <IBot />, tone: e.ok ? "good" : "warn", title: `Pillar ${e.ok ? "ok" : "failed"}: ${e.placed}/${e.requested} placed`, detail: e.reason ?? `${e.attempts} attempts` };
    case "structure_skip":
      return { icon: <IBot />, tone: "info", title: `Left ${e.skipped} player-built ${e.block.replace(/_/g, " ")} alone` };
    case "reflex":
      return { icon: <IZap />, tone: e.reflex === "defend" ? "warn" : "info", title: `Reflex: ${e.reflex}`, detail: e.detail };
    case "hurt":
      return { icon: <IHeart />, tone: e.health <= 6 ? "bad" : "warn", title: `Hurt${e.by ? ` by ${e.by}` : ""}`, detail: `health ${e.health}/20` };
    case "death":
      return { icon: <ISkull />, tone: "bad", title: `Died: ${e.cause}`, detail: fmtPos(e.pos) };
    case "connection":
      return { icon: <IWifiOff />, tone: e.state === "connected" ? "good" : "warn", title: `Connection ${e.state}`, detail: e.reason ?? (e.inWorldMs ? `after ${fmtMs(e.inWorldMs)} in world` : undefined) };
    case "loop_lag":
      return { icon: <IClock />, tone: "warn", title: `Event loop lag ${fmtMs(e.lagMs)}` };
    case "rate_limit":
      return { icon: <IAlert />, tone: "bad", title: `Rate limit: ${e.status}`, detail: e.resetsAt ? `resets ${fmtTime(e.resetsAt)}` : undefined };
    case "job_start":
      return { icon: <IBot />, tone: "info", title: `Job started: ${e.goals.map((g) => `${g.item} x${g.count}`).join(", ")}`, detail: `${e.steps} steps` };
    case "job_end":
      return { icon: e.status === "done" ? <ICheck /> : <IX />, tone: e.status === "done" ? "good" : e.status === "failed" ? "bad" : "", title: `Job ${e.status}`, detail: `${fmtMs(e.durationMs)} · ${e.steps} steps · ${e.replans} replans${e.failureKind ? ` · ${e.failureKind}` : ""}` };
    case "step":
      return { icon: <IZap />, tone: e.ok ? "" : "warn", title: `Step ${e.op} ${e.item}: ${e.ok ? "ok" : "failed"}`, detail: `${fmtMs(e.durationMs)}${e.failureKind ? ` · ${e.failureKind}` : ""}` };
    case "recovery":
      return { icon: <IAlert />, tone: "warn", title: `Recovery: ${e.rung}`, detail: e.detail };
    case "chat_in":
      return { icon: <IChat />, tone: "", title: `Chat from ${e.player}` };
    case "chat_out":
      return { icon: <IChat />, tone: "", title: `Bot ${e.channel}` };
  }
}

export function EventsPanel({ bot }: { bot: string }) {
  const [events, setEvents] = useState<Array<TelemetryEvent & { _new?: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5000);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    const since = Date.now() - 24 * 3600_000;
    api
      .get<TelemetryEvent[]>(`/api/bot/events?bot=${encodeURIComponent(bot)}&since=${since}&kinds=${NOTABLE_KINDS.join(",")}&limit=500`)
      .then((list) => {
        if (cancelled) return;
        setEvents(list.filter(isNotable).sort((a, b) => b.at - a.at).slice(0, MAX));
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof HttpError && e.status === 404) setEvents([]); // no telemetry yet
        else setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [bot]);

  useChannel("events", (m) => {
    if (m.type !== "event") return;
    const e = m.data as TelemetryEvent;
    if (!e || typeof e !== "object" || e.bot !== bot || !isNotable(e)) return;
    setEvents((list) => [{ ...e, _new: true }, ...(list ?? [])].slice(0, MAX));
  });

  if (error && !events) return <ErrorState error={error} />;
  if (!events) return <Card><Skeleton lines={8} /></Card>;
  return (
    <Card title="Notable events" flush actions={<span class="small dim" style={{ paddingRight: "16px" }}>last 24h · live</span>}>
      {events.length === 0 ? (
        <Empty title="Quiet">No failures, deaths, nav problems or task events in the last 24 hours.</Empty>
      ) : (
        <div class="feed" role="log" aria-live="polite" aria-label="Notable bot events">
          {events.map((e, idx) => {
            const d = describe(e);
            return (
              <div class={`feed-item ${e._new ? "new" : ""}`} key={`${e.at}-${e.kind}-${events.length - idx}`}>
                <span class={`ico ${d.tone}`} aria-hidden="true">{d.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflowWrap: "anywhere" }}>{d.title}</div>
                  {d.detail && <div class="small dim" style={{ overflowWrap: "anywhere" }}>{d.detail}</div>}
                </div>
                <span class="small dim nowrap tnum" title={new Date(e.at).toLocaleString()}>{fmtAgo(e.at, now)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
