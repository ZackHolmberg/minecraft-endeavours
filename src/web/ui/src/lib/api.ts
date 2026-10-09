import type { ApiError, MeResponse } from "../../../shared/api.js";
import { createStore } from "./store.js";

/**
 * HTTP client for the panel API. Auth is the HttpOnly session cookie only —
 * nothing is persisted client-side. The CSRF token lives in memory (from
 * /api/auth/me) and rides on every state-changing request.
 */

export type AuthState =
  | { status: "unknown" }
  | { status: "anonymous"; reason?: "expired" | "logged_out" }
  | { status: "authenticated"; me: MeResponse };

export const auth = createStore<AuthState>({ status: "unknown" });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

function csrf(): string | null {
  const a = auth.get();
  return a.status === "authenticated" ? a.me.csrfToken : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const t = csrf();
    if (t) headers["X-CSRF-Token"] = t;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new HttpError(0, "network", "Can't reach the panel. Check your connection.");
  }
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    // Session gone (expired, revoked, logged out elsewhere) → back to login.
    if (auth.get().status === "authenticated") auth.set({ status: "anonymous", reason: "expired" });
  }
  if (!res.ok) {
    let err: ApiError | null = null;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    const ra = res.headers.get("Retry-After");
    const retry = ra && /^\d+$/.test(ra) ? Number(ra) : null;
    throw new HttpError(res.status, err?.error ?? `http_${res.status}`, err?.message ?? `${res.status} ${res.statusText}`, retry);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
};

export function errorMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Validate the session and pick up a fresh CSRF token. */
export async function refreshSession(): Promise<void> {
  try {
    const me = await api.get<MeResponse>("/api/auth/me");
    auth.set({ status: "authenticated", me });
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      const prev = auth.get();
      auth.set({ status: "anonymous", reason: prev.status === "authenticated" ? "expired" : undefined });
    } else if (auth.get().status === "unknown") {
      // Panel unreachable on first load: show login with the error surfaced there.
      auth.set({ status: "anonymous" });
    }
  }
}

export async function logout(all = false): Promise<void> {
  try {
    await api.post(all ? "/api/auth/logout-all" : "/api/auth/logout");
  } finally {
    auth.set({ status: "anonymous", reason: "logged_out" });
  }
}
