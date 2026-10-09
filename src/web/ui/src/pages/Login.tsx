import { useEffect, useRef, useState } from "preact/hooks";
import type { LoginRequest, MeResponse } from "../../../shared/api.js";
import { api, auth, HttpError } from "../lib/api.js";
import { Alert } from "../components/ui.js";
import { IKey } from "../components/icons.js";

type Err = { tone: "bad" | "warn"; title: string; body: string } | null;

export function Login({ reason }: { reason?: "expired" | "logged_out" }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Err>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const totpRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pwRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= lockedUntil) {
        setLockedUntil(null);
        setErr(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const locked = lockedUntil !== null && now < lockedUntil;
  const remaining = locked ? Math.ceil((lockedUntil! - now) / 1000) : 0;
  const valid = password.length > 0 && /^\d{6}$/.test(totp);

  async function submit(e: Event) {
    e.preventDefault();
    if (!valid || busy || locked) return;
    setBusy(true);
    setErr(null);
    try {
      const body: LoginRequest = { password, totp };
      const me = await api.post<MeResponse>("/api/auth/login", body);
      setPassword("");
      auth.set({ status: "authenticated", me });
    } catch (e) {
      setTotp("");
      if (e instanceof HttpError && e.status === 429) {
        const secs = e.retryAfterSec ?? 60;
        setLockedUntil(Date.now() + secs * 1000);
        setNow(Date.now());
        setErr({
          tone: "warn",
          title: e.code === "rate_limited" ? "Too many attempts" : "Temporarily locked out",
          body: `${e.message} For your security, sign-in is paused.`,
        });
      } else if (e instanceof HttpError && e.status === 401) {
        setErr({ tone: "bad", title: "Incorrect password or code", body: "Check both and try again. Codes refresh every 30 seconds; repeated failures lock sign-in for a while." });
        totpRef.current?.focus();
      } else if (e instanceof HttpError && e.status === 0) {
        setErr({ tone: "bad", title: "Can't reach the panel", body: e.message });
      } else {
        setErr({ tone: "bad", title: "Sign-in failed", body: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="login-page">
      <div class="login-card">
        <div class="brand">
          <img src="./favicon.svg" alt="" />
          <span>Server Panel</span>
        </div>
        <form class="card stack" onSubmit={submit} noValidate>
          <h1 style={{ fontSize: "1.15rem" }}>Sign in</h1>
          {reason === "expired" && !err && <Alert tone="info">Your session ended. Sign in again to continue.</Alert>}
          {reason === "logged_out" && !err && <Alert tone="good">You've been signed out.</Alert>}
          {err && (
            <Alert tone={err.tone} title={err.title}>
              {err.body}
              {locked && <div style={{ marginTop: "4px" }}>Try again in <strong class="tnum">{fmtLeft(remaining)}</strong>.</div>}
            </Alert>
          )}
          <input type="text" name="username" autocomplete="username" value="admin" class="sr-only" tabIndex={-1} aria-hidden="true" readOnly />
          <div class="field">
            <label for="pw">Password</label>
            <input
              ref={pwRef}
              id="pw"
              class="input"
              type="password"
              autocomplete="current-password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              disabled={locked}
              required
            />
          </div>
          <div class="field">
            <label for="totp">Authenticator code</label>
            <input
              ref={totpRef}
              id="totp"
              class="input otp"
              type="text"
              inputMode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={totp}
              onInput={(e) => setTotp((e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6))}
              disabled={locked}
              aria-describedby="totp-help"
              required
            />
            <span id="totp-help" class="small dim">6-digit code from your authenticator app.</span>
          </div>
          <button class="btn primary block" type="submit" disabled={!valid || busy || locked} aria-busy={busy}>
            {busy ? <span class="spinner" aria-hidden="true" /> : <IKey />}
            {locked ? `Locked · ${fmtLeft(remaining)}` : busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p class="small dim" style={{ textAlign: "center", marginTop: "14px" }}>
          This panel controls a live server. Every sign-in attempt is audited.
        </p>
      </div>
    </main>
  );
}

function fmtLeft(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
