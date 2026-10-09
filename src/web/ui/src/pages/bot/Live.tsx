import type { BotSnapshot } from "../../../../../observability/snapshot.js";
import { fmtAgo, fmtMs, fmtNum, fmtPct, fmtPos, fmtUsd, prettyItem } from "../../lib/format.js";
import { Badge, Card, Empty, Meter } from "../../components/ui.js";
import { IBox, IChat, IMap, IPin, ISkull } from "../../components/icons.js";

const PHASE: Record<string, string> = { day: "☀ Day", night: "☾ Night", dusk: "Dusk", dawn: "Dawn" };

function vitalTone(v: number): "good" | "warn" | "bad" {
  return v <= 6 ? "bad" : v <= 12 ? "warn" : "good";
}

export function LivePanel({ s, now }: { s: BotSnapshot; now: number }) {
  const b = s.bot;
  const tel = s.telemetry;
  const ct = tel.currentTask;
  const inv = groupInventory(b?.inventory ?? []);
  return (
    <div class="stack">
      <div class="grid cols-3">
        <Card title="Doing now">
          {ct || s.state.currentTool ? (
            <div class="stack tight">
              {ct && (
                <>
                  <div style={{ fontWeight: 600 }}>“{ct.request ?? "(request not in ring)"}”</div>
                  <div class="row wrap small muted" style={{ gap: "4px 12px" }}>
                    <span class="tnum">running {fmtMs(ct.runningMs)}</span>
                    <span class="tnum">{ct.toolCalls} tool calls{ct.toolFailures ? ` · ${ct.toolFailures} failed` : ""}</span>
                    <span class="tnum">first reply {ct.firstReplyMs !== null ? fmtMs(ct.firstReplyMs) : "pending"}</span>
                  </div>
                </>
              )}
              {s.state.currentTool && (
                <div class="row" style={{ marginTop: "6px" }}>
                  <span class="spinner" aria-hidden="true" style={{ width: "14px", height: "14px" }} />
                  <code>{s.state.currentTool.name}</code>
                  <span class="small dim tnum">{fmtMs(s.state.currentTool.runningMs)}</span>
                </div>
              )}
            </div>
          ) : (
            <p class="muted">Idle — waiting for a player to ask for something.</p>
          )}
          <div class="divider" style={{ margin: "12px 0" }} />
          <dl class="kv">
            <dt>Talking to</dt>
            <dd>{s.chat.currentPartner ?? <span class="dim">nobody</span>}</dd>
          </dl>
        </Card>

        <Card title="Vitals">
          {b ? (
            <div class="stack tight">
              <div class="meter-row">
                <span class="muted">Health</span>
                <Meter value={b.health} max={20} tone={vitalTone(b.health)} label="Health" />
                <span class="tnum">{b.health}/20</span>
              </div>
              <div class="meter-row">
                <span class="muted">Food</span>
                <Meter value={b.food} max={20} tone={vitalTone(b.food)} label="Food" />
                <span class="tnum">{b.food}/20</span>
              </div>
              <div class="meter-row">
                <span class="muted">Satur.</span>
                <Meter value={b.saturation} max={20} tone="info" label="Saturation" />
                <span class="tnum">{b.saturation.toFixed(1)}</span>
              </div>
              <dl class="kv" style={{ marginTop: "8px" }}>
                <dt>XP level</dt>
                <dd>{b.experience}</dd>
                <dt>Holding</dt>
                <dd>{b.heldItem ? `${prettyItem(b.heldItem.name)} ×${b.heldItem.count}` : <span class="dim">empty hand</span>}</dd>
              </dl>
            </div>
          ) : (
            <p class="muted">Not in the world right now ({s.connection.state}).</p>
          )}
        </Card>

        <Card title="Where">
          {b ? (
            <dl class="kv">
              <dt>Position</dt>
              <dd class="mono">{fmtPos(b.position)}</dd>
              <dt>Dimension</dt>
              <dd>{b.dimension.replace(/^minecraft:/, "")}</dd>
              <dt>Facing</dt>
              <dd>{b.facing}</dd>
              <dt>Time</dt>
              <dd>{PHASE[b.time.phase] ?? b.time.phase}</dd>
              <dt>Weather</dt>
              <dd>{b.weather}</dd>
              <dt>Players seen</dt>
              <dd>{b.onlinePlayers.filter((p) => p !== s.username).join(", ") || <span class="dim">none</span>}</dd>
            </dl>
          ) : (
            <p class="muted">Position unknown while disconnected.</p>
          )}
        </Card>
      </div>

      <div class="grid cols-2">
        <Card title="Task queue">
          <TaskQueue current={s.state.currentTask} queued={s.state.remainingTasks} />
        </Card>
        <Card title="Recent actions">
          {s.state.recentActions.length === 0 ? (
            <p class="muted">No actions yet this session.</p>
          ) : (
            <ol class="stack tight" style={{ margin: 0, paddingLeft: "18px" }}>
              {[...s.state.recentActions].reverse().slice(0, 12).map((a, i) => (
                <li key={i} class="small" style={{ overflowWrap: "anywhere" }}>
                  {a}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card title={<>Inventory <span class="dim tnum">{inv.length}</span></>}>
        {inv.length === 0 ? (
          <p class="muted">{b ? "Empty." : "Unavailable while disconnected."}</p>
        ) : (
          <div class="inv">
            {inv.map((i) => (
              <div class="inv-item" key={i.name} title={i.name}>
                <span>{prettyItem(i.name)}</span>
                <span class="tnum dim">{i.count}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {s.agent && <AgentCard s={s} now={now} />}
    </div>
  );
}

function groupInventory(items: Array<{ name: string; count: number }>) {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function TaskQueue({ current, queued }: { current: string | null; queued: string[] }) {
  if (!current && queued.length === 0) return <p class="muted">Nothing queued.</p>;
  return (
    <ol class="stack tight" style={{ margin: 0, paddingLeft: "18px" }}>
      {current && (
        <li>
          <strong>{current}</strong> <Badge tone="info" plain>current</Badge>
        </li>
      )}
      {queued.map((t, i) => (
        <li key={i} class="muted">
          {t}
        </li>
      ))}
    </ol>
  );
}

function AgentCard({ s, now }: { s: BotSnapshot; now: number }) {
  const a = s.agent!;
  const u = a.sessionUsage;
  const totalIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  const ws = a.windowStats;
  return (
    <Card title="Agent session">
      <div class="grid tiles">
        <div>
          <div class="small dim">Turns</div>
          <div class="tnum" style={{ fontWeight: 650 }}>{fmtNum(u.turns)}</div>
        </div>
        <div>
          <div class="small dim">Session cost</div>
          <div class="tnum" style={{ fontWeight: 650 }}>{fmtUsd(u.total_cost_usd)}</div>
        </div>
        <div>
          <div class="small dim">Cache hit</div>
          <div class="tnum" style={{ fontWeight: 650 }}>{totalIn ? fmtPct(u.cache_read_input_tokens / totalIn) : "—"}</div>
        </div>
        <div>
          <div class="small dim">Tokens in / out</div>
          <div class="tnum" style={{ fontWeight: 650 }}>
            {fmtNum(totalIn)} / {fmtNum(u.output_tokens)}
          </div>
        </div>
        <div>
          <div class="small dim">5h window (est.)</div>
          <div class="tnum" style={{ fontWeight: 650 }}>{ws.estimatedCurrentUtilization !== null ? fmtPct(ws.estimatedCurrentUtilization) : "—"}</div>
        </div>
        <div>
          <div class="small dim">Rate limit</div>
          <div style={{ fontWeight: 650 }}>{a.rateLimited ? <Badge tone="bad">cooling {a.cooldownRemainingMinutes}m</Badge> : <Badge tone="good">ok</Badge>}</div>
        </div>
      </div>
      {a.lastTurnUsage && (
        <p class="small dim" style={{ marginTop: "10px" }}>
          Last turn: {fmtNum(a.lastTurnUsage.input_tokens + a.lastTurnUsage.cache_read_input_tokens + a.lastTurnUsage.cache_creation_input_tokens)} in ·{" "}
          {fmtNum(a.lastTurnUsage.output_tokens)} out · {fmtUsd(a.lastTurnUsage.total_cost_usd)}
          {ws.latestAnchor ? ` · window anchor ${fmtPct(ws.latestAnchor.utilization)} ${fmtAgo(ws.latestAnchor.at, now)}` : ""}
        </p>
      )}
    </Card>
  );
}

export function MemoryPanel({ s, now }: { s: BotSnapshot; now: number }) {
  const m = s.memory;
  if (!m) return <Card><Empty title="Reading memory from disk…">The first read lands within a few seconds of the bot starting.</Empty></Card>;
  return (
    <div class="stack">
      <p class="small dim">What the bot believes, read from disk {fmtAgo(m.refreshedAt, now)}.</p>
      {m.error && <div class="alert bad">world.json: {m.error}</div>}
      <div class="grid cols-3">
        <Card title={<>Places <span class="dim tnum">{m.pois.count}</span></>}>
          {m.pois.latest.length === 0 ? (
            <Empty icon={<IPin />} title="No places remembered" />
          ) : (
            <div class="stack tight">
              {m.pois.latest.map((p, i) => (
                <div class="row" key={i}>
                  <IMap width={16} height={16} class="dim" />
                  <div class="grow">
                    <div class="ellipsis">{p.name ?? prettyItem(p.type)}</div>
                    <div class="small dim mono">{fmtPos(p.position)} · {p.source} · {fmtAgo(p.timestamp, now)}</div>
                  </div>
                </div>
              ))}
              {m.pois.count > m.pois.latest.length && <div class="small dim">+{m.pois.count - m.pois.latest.length} more</div>}
            </div>
          )}
        </Card>
        <Card title={<>Containers <span class="dim tnum">{m.containers.count}</span></>}>
          {m.containers.latest.length === 0 ? (
            <Empty icon={<IBox />} title="No containers seen" />
          ) : (
            <div class="stack">
              {m.containers.latest.map((c, i) => (
                <div key={i}>
                  <div class="row between">
                    <strong>{prettyItem(c.type)}</strong>
                    <span class="small dim mono">{fmtPos(c.position)}</span>
                  </div>
                  <div class="small dim">opened by {c.last_opened_by} {fmtAgo(c.last_opened, now)}</div>
                  {c.contents && c.contents.length > 0 && (
                    <div class="small" style={{ marginTop: "2px" }}>
                      {c.contents.slice(0, 6).map((x) => `${prettyItem(x.item)} ×${x.count}`).join(", ")}
                      {c.contents.length > 6 ? ` +${c.contents.length - 6}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title={<>Deaths <span class="dim tnum">{m.deaths.count}</span></>}>
          {m.deaths.latest.length === 0 ? (
            <Empty icon={<ISkull />} title="No deaths recorded" />
          ) : (
            <div class="stack tight">
              {m.deaths.latest.map((d, i) => (
                <div key={i}>
                  <div>{d.cause}</div>
                  <div class="small dim mono">{fmtPos(d.position)} · {fmtAgo(d.timestamp, now)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <div class="grid cols-2">
        <Card title={<>Conversation <span class="dim tnum">{m.conversation.count}</span></>}>
          {m.conversation.tail.length === 0 ? (
            <Empty icon={<IChat />} title="No conversation on disk" />
          ) : (
            <div class="convo">
              {m.conversation.tail.map((c, i) => {
                const isBot = c.who === s.username;
                const note = !c.who;
                return (
                  <div key={i} class={`bubble ${note ? "note" : isBot ? "bot" : ""}`}>
                    {!note && (
                      <span class="who">
                        {c.who}
                        {c.channel === "whisper" ? ` → ${c.to ?? "whisper"}` : ""} · {fmtAgo(c.at, now)}
                      </span>
                    )}
                    {c.text}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <Card title="Persisted tasks">
          {m.tasks ? <TaskQueue current={m.tasks.currentTask} queued={m.tasks.queued} /> : <p class="muted">No tasks.json on disk.</p>}
        </Card>
      </div>
    </div>
  );
}
