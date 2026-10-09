import type { ButtonHTMLAttributes, ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createStore, useStore } from "../lib/store.js";
import { IAlert, IInfo, IWifiOff, IX } from "./icons.js";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export function Badge({ tone = "neutral", plain, children }: { tone?: Tone; plain?: boolean; children: ComponentChildren }) {
  return <span class={`badge ${tone}${plain ? " plain" : ""}`}>{children}</span>;
}

export function Card(props: { title?: ComponentChildren; actions?: ComponentChildren; flush?: boolean; class?: string; children: ComponentChildren; id?: string }) {
  const headingId = props.id ? `${props.id}-h` : undefined;
  return (
    <section class={`card${props.flush ? " flush" : ""} ${props.class ?? ""}`} aria-labelledby={headingId} id={props.id}>
      {(props.title || props.actions) && (
        <div class="card-head">
          <h2 id={headingId}>{props.title}</h2>
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}

export function Tile(props: { label: string; value: ComponentChildren; unit?: string; sub?: ComponentChildren; tone?: "warn" | "bad" }) {
  return (
    <div class={`tile ${props.tone ?? ""}`}>
      <div class="label">{props.label}</div>
      <div class="value">
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </div>
      {props.sub !== undefined && <div class="sub">{props.sub}</div>}
    </div>
  );
}

export function Alert({ tone = "info", title, children }: { tone?: "bad" | "warn" | "info" | "good"; title?: ComponentChildren; children?: ComponentChildren }) {
  const Icon = tone === "info" || tone === "good" ? IInfo : IAlert;
  return (
    <div class={`alert ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon />
      <div class="grow">
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ComponentChildren; title: string; children?: ComponentChildren }) {
  return (
    <div class="state">
      {icon}
      <strong>{title}</strong>
      {children && <div class="small">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div class="state" role="alert">
      <IWifiOff />
      <strong>Couldn't load this</strong>
      <div class="small">{error}</div>
      {onRetry && (
        <button class="btn sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div class="stack tight" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} class="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** Data/loading/error switch used by every panel. */
export function Load<T>(props: {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload?: () => void;
  lines?: number;
  children: (d: T) => ComponentChildren;
}) {
  if (props.data !== null) {
    return (
      <>
        {props.error && <Alert tone="warn" title="Showing last known data">{props.error}</Alert>}
        {props.children(props.data)}
      </>
    );
  }
  if (props.error) return <ErrorState error={props.error} onRetry={props.reload} />;
  return <Skeleton lines={props.lines} />;
}

export function Meter({ value, max, tone, label }: { value: number; max: number; tone?: Tone; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div class={`meter ${tone ?? ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────

interface ConfirmReq {
  title: string;
  body?: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  /** Typed confirmation: the confirm button stays disabled until the user types exactly this. */
  requireText?: string;
  resolve: (ok: boolean) => void;
}
const confirmStore = createStore<ConfirmReq | null>(null);

export function confirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  return new Promise((resolve) => confirmStore.set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const req = useStore(confirmStore);
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!req) return;
    setTyped("");
    const prev = document.activeElement as HTMLElement | null;
    if (req.requireText !== undefined) typeRef.current?.focus();
    else (req.danger ? cancelRef : okRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Tab") {
        // Keep focus inside the dialog.
        const els = [typeRef.current, cancelRef.current, okRef.current].filter((el) => el && !(el as HTMLButtonElement).disabled) as HTMLElement[];
        const i = els.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
      }
    };
    addEventListener("keydown", onKey);
    const onNav = () => close(false);
    addEventListener("hashchange", onNav);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("hashchange", onNav);
      prev?.focus?.();
    };
  }, [req]);
  if (!req) return null;
  const blocked = req.requireText !== undefined && typed !== req.requireText;
  function close(ok: boolean) {
    req!.resolve(ok);
    confirmStore.set(null);
  }
  return (
    <div class="dialog-wrap">
      <div class="scrim" onClick={() => close(false)} />
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{req.title}</h2>
        <div id="confirm-body" class="muted">
          {req.body}
        </div>
        {req.requireText !== undefined && (
          <div class="field" style={{ marginTop: "14px" }}>
            <label for="confirm-type">
              Type <code>{req.requireText}</code> to confirm
            </label>
            <input
              id="confirm-type"
              ref={typeRef}
              class="input mono"
              value={typed}
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocked) close(true);
              }}
            />
          </div>
        )}
        <div class="actions">
          <button ref={cancelRef} class="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button ref={okRef} class={`btn ${req.danger ? "danger solid" : "primary"}`} disabled={blocked} onClick={() => close(true)}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────

interface ToastItem {
  id: number;
  tone: "ok" | "bad";
  text: ComponentChildren;
}
const toastStore = createStore<ToastItem[]>([]);
let toastId = 0;

export function toast(text: ComponentChildren, tone: "ok" | "bad" = "ok", ms = 4500): void {
  const id = ++toastId;
  toastStore.set((ts) => [...ts.slice(-3), { id, tone, text }]);
  setTimeout(() => toastStore.set((ts) => ts.filter((t) => t.id !== id)), ms);
}

export function ToastHost() {
  const ts = useStore(toastStore);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {ts.map((t) => (
        <div key={t.id} class={`toast ${t.tone === "bad" ? "bad" : ""}`}>
          <div class="grow">{t.text}</div>
          <button aria-label="Dismiss" onClick={() => toastStore.set((x) => x.filter((y) => y.id !== t.id))}>
            <IX width={16} height={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Button that shows a spinner while its async handler runs. */
export function AsyncButton(
  props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { onClick: () => Promise<unknown> | void; children: ComponentChildren },
) {
  const { onClick, children, disabled, ...rest } = props;
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...rest}
      disabled={Boolean(disabled) || busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span class="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
