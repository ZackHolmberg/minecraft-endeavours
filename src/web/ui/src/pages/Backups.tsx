import type { BackupInfo } from "../../../shared/api.js";
import { useFetch } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";
import { status } from "../lib/status.js";
import { runAction } from "../lib/actions.js";
import { fmtAgo, fmtBytes, fmtDateTime } from "../lib/format.js";
import { AsyncButton, Card, Empty, Load, Tile } from "../components/ui.js";
import { IArchive } from "../components/icons.js";

export function Backups() {
  const b = useFetch<BackupInfo[]>("/api/backups", { interval: 30_000 });
  const st = useStore(status);
  const running = st.data?.activeJobs.some((j) => j.action === "backup.run") ?? false;
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
              disabled={running}
              onClick={async () => {
                await runAction({ id: "backup.run", label: "Run backup", description: "Saves the world, then archives it to ./backups.", confirm: false });
                setTimeout(b.reload, 3000);
              }}
            >
              {!running && <IArchive />}
              {running ? "Backing up…" : "Back up now"}
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
    </div>
  );
}
