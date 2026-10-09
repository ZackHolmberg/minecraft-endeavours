import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { WsChannel, WsServerMessage } from "../../../shared/api.js";
import { api, errorMessage, HttpError } from "./api.js";
import { onMessage, subscribe } from "./ws.js";

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  /** HTTP status of the last error (0 = network), null when OK. */
  errorStatus: number | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T | ((p: T | null) => T)) => void;
}

/** GET a path; optional polling. Keeps the last good data across errors. */
export function useFetch<T>(path: string | null, opts: { interval?: number } = {}): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const my = ++seq.current;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (my !== seq.current) return;
        setData(d);
        setError(null);
        setErrorStatus(null);
      })
      .catch((e) => {
        if (my !== seq.current) return;
        setError(errorMessage(e));
        setErrorStatus(e instanceof HttpError ? e.status : null);
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
  }, [path, tick]);

  useEffect(() => {
    setData(null);
    setError(null);
    setErrorStatus(null);
  }, [path]);

  useEffect(() => {
    if (!opts.interval || path === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, opts.interval);
    return () => clearInterval(id);
  }, [opts.interval, path]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((d: T | ((p: T | null) => T)) => {
    setData((prev) => (typeof d === "function" ? (d as (p: T | null) => T)(prev) : d));
  }, []);
  return { data, error, errorStatus, loading, reload, setData: set };
}

/** Subscribe to a WS channel while mounted; handler sees every frame. */
export function useChannel(channel: WsChannel | null, handler: (m: WsServerMessage) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!channel) return;
    const off = onMessage((m) => ref.current(m));
    const unsub = subscribe(channel);
    return () => {
      off();
      unsub();
    };
  }, [channel]);
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
