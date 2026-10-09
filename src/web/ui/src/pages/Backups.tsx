import { useEffect, useState } from "preact/hooks";
import type { ActionDef, BackupInfo } from "../../../shared/api.js";
import { useFetch } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";
import { status } from "../lib/status.js";
import { runAction, SEED_RE, startNewWorld } from "../lib/actions.js";
import { fmtAgo, fmtBytes, fmtDateTime } from "../lib/format.js";
import { Alert, AsyncButton, Badge, Card, Empty, Load, Tile } from "../components/ui.js";
import { IArchive, IMap } from "../components/icons.js";
import { JobOutput } from "./Jobs.js";

export function Backups() {
  const b = useFetch<BackupInfo[]>("/api/backups", { interval: 30_000 });
  const st = useStore(status);
  const running = st.data?.activeJobs.some((j) => j.action === "backup.run") ?? false;
  const generating = st.data?.activeJobs.some((j) => j.action === "world.new") ?? false;
  const list = b.data ?? [];
  const total = list.reduce((n, x) => n + x.sizeBytes, 0);
  return (
    <div class="stack">
      <div class="grid tiles">
        <Tile label="Backups" value={b.data ? list.length : "—"} sub="Keeps the last 10" />
        <Tile label="Latest" value={list[0] ? fmtAgo(list[0].createdAt) : "—"} sub={list[0] ? fmtDateTime(list[0].createdAt) : "none yet"} />
        <Tile label="Total size" value={b.data ? fmtBytes(total) : "—"} />
      </div>
      <Card
        title="World backups"
        flush
        actions={
          <div style={{ paddingRight: "16px" }}>
            <AsyncButton
              class="btn sm primary"
              disabled={running || generating}
              onClick={async () => {
                await runAction({ id: "backup.run", label: "Run backup", description: "Saves the world, then archives it to ./backups.", confirm: false });
                setTimeout(b.reload, 3000);
              }}
            >
              {!running && <IArchive />}
              {running ? "Backing up…" : generating ? "New world running…" : "Back up now"}
            </AsyncButton>
          </div>
        }
      >
        <Load {...b} lines={5}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty icon={<IArchive />} title="No backups yet">Run one now — it saves the world first, so it's safe while players are online.</Empty>
            ) : (
              <div class="list">
                {rows.map((x, i) => (
                  <div class="list-item" key={x.file}>
                    <span class="avatar" aria-hidden="true"><IArchive width={18} height={18} /></span>
                    <div class="grow">
                      <div class="mono ellipsis" style={{ fontWeight: 600 }}>{x.file}</div>
                      <div class="small muted">
                        {fmtDateTime(x.createdAt)} · {fmtAgo(x.createdAt)}
                        {i === 0 ? " · latest" : ""}
                      </div>
                    </div>
                    <span class="tnum small nowrap">{fmtBytes(x.sizeBytes)}</span>
                  </div>
                ))}
              </div>
            )
          }
        </Load>
      </Card>
      <p class="small dim">Download and restore aren't available from the panel yet — backups live in <code>./backups/</code> on the host.</p>
      <NewWorldCard onDone={() => setTimeout(b.reload, 1000)} />
    </div>
  );
}

function NewWorldCard({ onDone }: { onDone: () => void }) {
  const st = useStore(status);
  const actions = useFetch<ActionDef[]>("/api/actions");
  const [seed, setSeed] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const active = st.data?.activeJobs.find((j) => j.action === "world.new") ?? null;
  // Pick up a run started elsewhere (another tab/device) so its output shows here too.
  useEffect(() => {
    if (active && active.id !== jobId) setJobId(active.id);
  }, [active?.id]);
  const activeKey = st.data?.activeJobs.map((j) => j.id).join(",") ?? "";
  const serverKey = `${st.data?.server.state}|${st.data?.server.reachable}`;
  useEffect(() => {
    actions.reload();
    if (!active && jobId) onDone();
  }, [activeKey, serverKey]);

  const def = actions.data?.find((a) => a.id === "world.new") ?? null;
  const trimmed = seed.trim();
  const seedOk = trimmed === "" || SEED_RE.test(trimmed);
  const running = active !== null;

  return (
    <Card id="new-world" title={<span class="row" style={{ gap: "8px" }}><IMap width={18} height={18} /> New world</span>} actions={running ? <Badge tone="info">Generating</Badge> : <Badge tone="warn" plain>Destructive</Badge>}>
      <div class="stack">
        <div class="small muted stack tight">
          <p style={{ margin: 0 }}>Replaces the current world with a freshly generated one. In order, the panel:</p>
          <ol style={{ margin: 0, paddingLeft: "20px" }}>
            <li>runs a normal backup (when the server is up),</li>
            <li>stops the bot and the server — <strong>everyone online is disconnected</strong>,</li>
            <li>moves the world folders to <code>backups/worlds/&lt;time&gt;/</code>,</li>
            <li>moves the bot's memory to <code>memory-archive/&lt;time&gt;/</code> — it starts the new world knowing nothing,</li>
            <li>starts the server, waits for it to generate the world, and restarts the bot if it was running.</li>
          </ol>
          <p style={{ margin: 0 }}>
            Nothing is deleted — old worlds pile up in <code>backups/worlds/</code> until you remove them on the host. It takes a few minutes. To go back, stop the server and move a world folder back into <code>data/</code> on the host.
          </p>
        </div>
        <form
          class="stack tight"
          onSubmit={(e) => e.preventDefault()}
        >
          <div class="field">
            <label for="nw-seed">Seed (optional)</label>
            <div class="row">
              <input
                id="nw-seed"
                class="input mono grow"
                placeholder="Random"
                value={seed}
                maxLength={33}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                disabled={running}
                aria-invalid={!seedOk}
                aria-describedby="nw-seed-hint"
                onInput={(e) => setSeed((e.target as HTMLInputElement).value)}
              />
              <AsyncButton
                class="btn danger"
                type="submit"
                disabled={running || !seedOk || !def?.available}
                onClick={async () => {
                  const job = await startNewWorld(seed);
                  if (job) {
                    setJobId(job.id);
                    setSeed("");
                    actions.reload();
                  }
                }}
              >
                <span class="nowrap">Start new world…</span>
              </AsyncButton>
            </div>
            <div id="nw-seed-hint" class={seedOk ? "small dim" : "field-error"} aria-live="polite">
              {seedOk
                ? trimmed === ""
                  ? "Leave empty for a random world. Numbers or text both work."
                  : "Same seed + same version = same terrain."
                : "Up to 32 letters, digits, spaces or _ (an optional leading - for numbers)."}
            </div>
          </div>
          {def && !def.available && !running && def.unavailableReason && <p class="action-reason" style={{ margin: 0 }}>{def.unavailableReason}</p>}
        </form>
        {jobId && <JobOutput key={jobId} id={jobId} />}
        {!running && jobId === null && st.data && !st.data.server.reachable && st.data.server.state !== "unknown" && (
          <Alert tone="info">The server is stopped, so the backup step is skipped — the world folders are still archived intact.</Alert>
        )}
      </div>
    </Card>
  );
}
