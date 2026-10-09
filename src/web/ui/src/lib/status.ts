import type { StatusResponse } from "../../../shared/api.js";
import { api, auth, errorMessage } from "./api.js";
import { createStore } from "./store.js";
import { liveState, onMessage, subscribe } from "./ws.js";

/**
 * App-wide server status. Pushed over the WS `status` channel; while the
 * socket is down we fall back to polling GET /api/status so the overview
 * never goes stale silently.
 */
export const status = createStore<{ data: StatusResponse | null; error: string | null; receivedAt: number }>({
  data: null,
  error: null,
  receivedAt: 0,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsub: (() => void) | null = null;

async function poll(): Promise<void> {
  try {
    const d = await api.get<StatusResponse>("/api/status");
    status.set({ data: d, error: null, receivedAt: Date.now() });
  } catch (e) {
    status.set((s) => ({ ...s, error: errorMessage(e) }));
  }
}

function startPolling(): void {
  if (pollTimer) return;
  void poll();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") void poll();
  }, 8000);
}
function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

onMessage((m) => {
  if (m.type === "status") status.set({ data: m.data, error: null, receivedAt: Date.now() });
});

liveState.subscribe((s) => {
  if (auth.get().status !== "authenticated") return;
  if (s === "live") stopPolling();
  else startPolling();
});

auth.subscribe((a) => {
  if (a.status === "authenticated") {
    void poll();
    if (!unsub) unsub = subscribe("status");
    if (liveState.get() !== "live") startPolling();
  } else {
    unsub?.();
    unsub = null;
    stopPolling();
    status.set({ data: null, error: null, receivedAt: 0 });
  }
});

export function refreshStatus(): void {
  void poll();
}
