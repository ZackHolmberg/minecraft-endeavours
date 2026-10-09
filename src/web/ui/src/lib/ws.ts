import type { WsChannel, WsClientMessage, WsServerMessage } from "../../../shared/api.js";
import { auth, refreshSession } from "./api.js";
import { createStore } from "./store.js";

/**
 * One multiplexed WebSocket at /api/ws. Channels are ref-counted: components
 * subscribe while mounted, and every live channel is re-subscribed after a
 * reconnect. Reconnects back off exponentially (1s → 30s, jittered).
 */

export type LiveState = "connecting" | "live" | "offline";
export const liveState = createStore<LiveState>("connecting");

type Listener = (msg: WsServerMessage) => void;

const listeners = new Set<Listener>();
const channels = new Map<WsChannel, number>();
let sock: WebSocket | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;

function url(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/ws`;
}

function send(msg: WsClientMessage): void {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function connect(): void {
  if (!wanted || sock) return;
  liveState.set("connecting");
  let s: WebSocket;
  try {
    s = new WebSocket(url());
  } catch {
    scheduleReconnect();
    return;
  }
  sock = s;
  s.onopen = () => {
    attempt = 0;
    liveState.set("live");
    for (const ch of channels.keys()) send({ type: "subscribe", channel: ch });
  };
  s.onmessage = (ev) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as WsServerMessage;
    } catch {
      return;
    }
    if (msg.type === "error" && msg.error.error === "unauthorized") {
      void refreshSession();
    }
    for (const fn of listeners) fn(msg);
  };
  s.onclose = () => {
    if (sock === s) sock = null;
    liveState.set("offline");
    scheduleReconnect();
  };
  s.onerror = () => {
    /* onclose follows */
  };
}

function scheduleReconnect(): void {
  if (!wanted || timer) return;
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  const delay = base / 2 + Math.random() * (base / 2);
  attempt++;
  timer = setTimeout(() => {
    timer = null;
    // A closed socket can mean the session died; /me will flip auth if so.
    if (attempt > 1) void refreshSession();
    connect();
  }, delay);
}

export function startLive(): void {
  wanted = true;
  connect();
}

export function stopLive(): void {
  wanted = false;
  if (timer) clearTimeout(timer);
  timer = null;
  attempt = 0;
  const s = sock;
  sock = null;
  s?.close();
  liveState.set("offline");
}

/** Reconnect immediately (e.g. tab became visible or network returned). */
export function nudgeLive(): void {
  if (!wanted) return;
  if (sock) return;
  if (timer) clearTimeout(timer);
  timer = null;
  attempt = 0;
  connect();
}

export function onMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function subscribe(ch: WsChannel): () => void {
  const n = channels.get(ch) ?? 0;
  channels.set(ch, n + 1);
  if (n === 0) send({ type: "subscribe", channel: ch });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const m = (channels.get(ch) ?? 1) - 1;
    if (m <= 0) {
      channels.delete(ch);
      send({ type: "unsubscribe", channel: ch });
    } else channels.set(ch, m);
  };
}

auth.subscribe((a) => {
  if (a.status === "authenticated") startLive();
  else stopLive();
});
