/**
 * Periodic snapshot dumper for the out-of-process dashboard.
 *
 * The orchestrator runs detached (started by `scripts/botStart.sh`); the
 * dashboard (`scripts/dashboard.sh`) is a separate blessed process that
 * reads from disk. To bridge the two we serialize every bot's snapshot plus
 * the tail of the log ring buffer into a single JSON file on a 500ms tick.
 *
 * Writes are atomic via tmp-file + rename, so the dashboard never sees a
 * half-written JSON document during a poll.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getRecentLogs, type LogEntry } from "./observability/log-buffer.js";
import { getAllBotSnapshots, type BotSnapshot } from "./observability/snapshot.js";

const TICK_MS = 500;
const LOG_TAIL = 200;

export interface SnapshotFilePayload {
  capturedAt: number;
  snapshots: BotSnapshot[];
  recentLogs: LogEntry[];
}

export function startSnapshotWriter(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });

  const write = (): void => {
    const payload: SnapshotFilePayload = {
      capturedAt: Date.now(),
      snapshots: getAllBotSnapshots(),
      recentLogs: getRecentLogs(LOG_TAIL),
    };
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
    } catch (err) {
      // Never let a snapshot-write failure crash the orchestrator.
      console.error("snapshot-writer: write failed", err);
    }
  };

  write();
  const interval = setInterval(write, TICK_MS);
  return () => clearInterval(interval);
}
