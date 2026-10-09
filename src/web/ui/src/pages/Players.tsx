import { useState } from "preact/hooks";
import type { GameMode, PlayersResponse } from "../../../shared/api.js";
import { MODE_LABEL, setGameMode } from "../lib/gamemode.js";
import { api, errorMessage } from "../lib/api.js";
import { useFetch } from "../lib/hooks.js";
import { AsyncButton, Badge, Card, Empty, Load, confirm, toast } from "../components/ui.js";
import { ICrown, IMegaphone, IPlus, ITrash, IUsers, IX } from "../components/icons.js";

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function Players() {
  const p = useFetch<PlayersResponse>("/api/players", { interval: 15_000 });

  async function mutate(path: string, body: object, done: string) {
    try {
      const next = await api.post<PlayersResponse>(path, body);
      p.setData(next);
      toast(done);
    } catch (e) {
      toast(errorMessage(e), "bad", 7000);
    }
  }

  const kick = async (name: string) => {
    let reason = "";
    const ok = await confirm({
      title: `Kick ${name}?`,
      body: <KickReason onChange={(r) => (reason = r)} />,
      confirmLabel: "Kick",
      danger: true,
    });
    if (ok) await mutate("/api/players/kick", reason.trim() ? { name, reason: reason.trim() } : { name }, `Kicked ${name}`);
  };
  const setOp = async (name: string, op: boolean) => {
    if (op) {
      const ok = await confirm({ title: `Make ${name} an operator?`, body: "Operators can run every server command in-game.", confirmLabel: "Grant op" });
      if (!ok) return;
    }
    await mutate("/api/players/op", { name, op }, op ? `${name} is now an operator` : `Removed op from ${name}`);
  };
  const setWl = async (name: string, add: boolean) => {
    if (!add) {
      const ok = await confirm({ title: `Remove ${name} from the whitelist?`, body: "They won't be able to join until re-added. The server is offline-mode, so the whitelist is the only access gate.", confirmLabel: "Remove", danger: true });
      if (!ok) return;
    }
    await mutate("/api/players/whitelist", { name, add }, add ? `Whitelisted ${name}` : `Removed ${name} from whitelist`);
  };

  return (
    <div class="stack">
      <Load {...p} lines={6}>
        {(d) => (
          <div class="grid cols-3">
            <Card title={<>Online <span class="dim tnum">{d.online.length}</span></>} flush>
              {d.online.length === 0 ? (
                <Empty icon={<IUsers />} title="Nobody online" />
              ) : (
                <div class="list">
                  {d.online.map((n) => (
                    <div class="list-item" key={n}>
                      <span class="avatar" aria-hidden="true">{n[0]?.toUpperCase()}</span>
                      <div class="grow">
                        <div class="ellipsis" style={{ fontWeight: 600 }}>{n}</div>
                        <div class="row" style={{ gap: "4px" }}>
                          {modeOf(d.gameModes, n) ? <Badge tone={modeOf(d.gameModes, n) === "creative" ? "info" : "neutral"} plain>{MODE_LABEL[modeOf(d.gameModes, n)!]}</Badge> : <Badge plain>mode ?</Badge>}
                          {d.ops.includes(n) && <Badge tone="info" plain>op</Badge>}
                          {!d.whitelist.includes(n) && <Badge tone="warn" plain>not whitelisted</Badge>}
                        </div>
                        <ModePicker name={n} mode={modeOf(d.gameModes, n)} onSet={async (m) => { const next = await setGameMode(n, m); if (next) p.setData(next); }} />
                      </div>
                      <button class="btn sm danger" onClick={() => void kick(n)} aria-label={`Kick ${n}`}>
                        Kick
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title={<>Whitelist <span class="dim tnum">{d.whitelist.length}</span></>} flush>
              <AddName label="Add to whitelist" onAdd={(n) => setWl(n, true)} exclude={d.whitelist} />
              <div class="list">
                {d.whitelist.length === 0 && <Empty title="Whitelist is empty">Nobody can join while the whitelist is enforced.</Empty>}
                {d.whitelist.map((n) => (
                  <div class="list-item" key={n}>
                    <span class="avatar" aria-hidden="true">{n[0]?.toUpperCase()}</span>
                    <div class="grow ellipsis">
                      {n} {d.online.includes(n) && <Badge tone="good" plain>online</Badge>}
                    </div>
                    <button class="btn sm icon ghost" onClick={() => void setOp(n, !d.ops.includes(n))} aria-label={d.ops.includes(n) ? `Remove op from ${n}` : `Make ${n} operator`} title={d.ops.includes(n) ? "Deop" : "Op"} aria-pressed={d.ops.includes(n)}>
                      <ICrown style={d.ops.includes(n) ? { color: "var(--warn-ink)" } : undefined} />
                    </button>
                    <button class="btn sm icon ghost" onClick={() => void setWl(n, false)} aria-label={`Remove ${n} from whitelist`} title="Remove">
                      <ITrash />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
            <Card title={<>Operators <span class="dim tnum">{d.ops.length}</span></>} flush>
              <AddName label="Grant operator" onAdd={(n) => setOp(n, true)} exclude={d.ops} />
              <div class="list">
                {d.ops.length === 0 && <Empty icon={<ICrown />} title="No operators" />}
                {d.ops.map((n) => (
                  <div class="list-item" key={n}>
                    <span class="avatar" aria-hidden="true">{n[0]?.toUpperCase()}</span>
                    <div class="grow ellipsis">{n}</div>
                    <button class="btn sm" onClick={() => void setOp(n, false)} aria-label={`Remove op from ${n}`}>
                      Deop
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </Load>
      <Broadcast />
    </div>
  );
}

/** One-tap Survival/Creative; Adventure/Spectator tucked behind a smaller toggle. */
export function ModePicker({ name, mode, onSet }: { name: string; mode: GameMode | null; onSet: (m: GameMode) => Promise<void> }) {
  const [busy, setBusy] = useState<GameMode | null>(null);
  const [more, setMore] = useState(mode === "adventure" || mode === "spectator");
  const pick = async (m: GameMode) => {
    if (m === mode || busy) return;
    setBusy(m);
    try {
      await onSet(m);
    } finally {
      setBusy(null);
    }
  };
  const btn = (m: GameMode) => (
    <button key={m} type="button" aria-pressed={mode === m} disabled={busy !== null} onClick={() => void pick(m)}>
      {busy === m ? <span class="spinner" aria-hidden="true" style={{ width: "12px", height: "12px" }} /> : null} {MODE_LABEL[m]}
    </button>
  );
  return (
    <div class="row wrap" style={{ gap: "6px", marginTop: "6px" }}>
      <div class="seg" role="group" aria-label={`Game mode for ${name}`}>
        {btn("survival")}
        {btn("creative")}
      </div>
      {more && (
        <div class="seg" role="group" aria-label={`Other game modes for ${name}`}>
          {btn("adventure")}
          {btn("spectator")}
        </div>
      )}
      {!more && (
        <button type="button" class="btn sm ghost small" style={{ minHeight: "32px", padding: "0 8px" }} onClick={() => setMore(true)} aria-label={`More game modes for ${name}`}>
          More…
        </button>
      )}
    </div>
  );
}

function KickReason({ onChange }: { onChange: (r: string) => void }) {
  return (
    <div class="field" style={{ marginTop: "10px" }}>
      <label for="kick-reason">Reason (optional)</label>
      <input id="kick-reason" class="input" maxLength={200} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    </div>
  );
}

function AddName({ label, onAdd, exclude }: { label: string; onAdd: (name: string) => Promise<void>; exclude: string[] }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const valid = NAME_RE.test(trimmed);
  const dup = exclude.some((e) => e.toLowerCase() === trimmed.toLowerCase());
  const id = `add-${label.replace(/\W/g, "")}`;
  return (
    <form
      style={{ padding: "0 16px 12px", borderBottom: "1px solid var(--border)" }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || dup || busy) return;
        setBusy(true);
        await onAdd(trimmed);
        setBusy(false);
        setName("");
      }}
    >
      <label for={id} class="sr-only">{label}</label>
      <div class="row">
        <input
          id={id}
          class="input"
          placeholder="Username"
          value={name}
          maxLength={16}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          aria-invalid={trimmed.length > 0 && (!valid || dup)}
          aria-describedby={`${id}-err`}
        />
        <button class="btn primary icon" type="submit" disabled={!valid || dup || busy} aria-label={label} title={label}>
          {busy ? <span class="spinner" /> : <IPlus />}
        </button>
      </div>
      <div id={`${id}-err`} class="field-error" aria-live="polite">
        {trimmed.length > 0 && !valid ? "3–16 letters, digits or _" : dup ? "Already on the list" : ""}
      </div>
    </form>
  );
}

function Broadcast() {
  const [msg, setMsg] = useState("");
  return (
    <Card title="Broadcast">
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <label for="say" class="sr-only">Message to all players</label>
        <input id="say" class="input grow" placeholder="Message everyone on the server…" value={msg} maxLength={256} onInput={(e) => setMsg((e.target as HTMLInputElement).value)} />
        {msg && (
          <button type="button" class="btn icon ghost" aria-label="Clear" onClick={() => setMsg("")}>
            <IX />
          </button>
        )}
        <AsyncButton
          class="btn primary"
          type="submit"
          disabled={!msg.trim()}
          onClick={async () => {
            try {
              await api.post("/api/players/say", { message: msg.trim() });
              toast("Message sent");
              setMsg("");
            } catch (e) {
              toast(errorMessage(e), "bad");
            }
          }}
        >
          <IMegaphone /> <span class="only-desktop">Say</span>
        </AsyncButton>
      </form>
      <p class="small dim" style={{ marginTop: "6px" }}>Sent with <code>say</code> — appears in chat as [Server].</p>
    </Card>
  );
}

/** Own-property lookup: names like "constructor" or "toString" are valid usernames. */
function modeOf(modes: Record<string, GameMode> | undefined, name: string): GameMode | null {
  return modes && Object.hasOwn(modes, name) ? modes[name]! : null;
}
