import type { ComponentChildren } from "preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { fmtNum } from "../lib/format.js";

/**
 * Hand-rolled SVG charts. Rendered at the container's real pixel width
 * (ResizeObserver) so text never scales. Styling comes from classes in
 * styles.css — nothing inline but geometry.
 */

export interface Pt {
  x: number; // unix ms
  y: number;
  tip: string; // tooltip text
  bad?: boolean; // e.g. failed / max_turns task
}

export interface Series {
  name: string;
  cls: "s1" | "s2";
  points: Pt[];
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const tFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function TimeChart(props: {
  series: Series[];
  height?: number;
  yFmt: (v: number) => string;
  /** Dashed reference line (e.g. a flag threshold). */
  refLine?: { y: number; label: string };
  label: string;
  empty?: ComponentChildren;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ si: number; i: number } | null>(null);
  const H = props.height ?? 180;
  const all = props.series.flatMap((s) => s.points);
  const pad = { l: 44, r: 12, t: 10, b: 24 };

  if (all.length === 0) {
    return (
      <div class="chart" ref={ref}>
        <div class="state small">{props.empty ?? "No data in this window yet."}</div>
      </div>
    );
  }

  const xs = all.map((p) => p.x);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x1 - x0 < 60_000) {
    x0 -= 30_000;
    x1 += 30_000;
  }
  const yMax = niceMax(Math.max(...all.map((p) => p.y), props.refLine?.y ?? 0) * 1.05);
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y: number) => pad.t + ih - (y / yMax) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const spanDays = (x1 - x0) > 36 * 3600_000;
  const xTickN = Math.max(2, Math.min(5, Math.floor(iw / 90)));
  const xTicks = Array.from({ length: xTickN }, (_, i) => x0 + ((x1 - x0) * i) / (xTickN - 1));

  function onMove(e: PointerEvent) {
    const svg = e.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best: { si: number; i: number; d: number } | null = null;
    props.series.forEach((s, si) =>
      s.points.forEach((p, i) => {
        const d = Math.abs(sx(p.x) - px);
        if (!best || d < best.d) best = { si, i, d };
      }),
    );
    const b = best as { si: number; i: number; d: number } | null;
    setHover(b && b.d < 40 ? { si: b.si, i: b.i } : null);
  }

  const hp = hover ? props.series[hover.si]?.points[hover.i] : undefined;
  const showDots = all.length <= 120;

  return (
    <div class="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={props.label}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line class="grid-line" x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} />
              <text class="axis-text" x={pad.l - 6} y={sy(t) + 4} text-anchor="end">
                {props.yFmt(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={i} class="axis-text" x={sx(t)} y={H - 6} text-anchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
              {spanDays ? `${dFmt.format(t)} ${tFmt.format(t)}` : tFmt.format(t)}
            </text>
          ))}
          {props.refLine && (
            <g>
              <line class="ref-line" x1={pad.l} x2={width - pad.r} y1={sy(props.refLine.y)} y2={sy(props.refLine.y)} />
              <text class="axis-text" x={width - pad.r} y={sy(props.refLine.y) - 4} text-anchor="end">
                {props.refLine.label}
              </text>
            </g>
          )}
          {props.series.map((s) => {
            const pts = [...s.points].sort((a, b) => a.x - b.x);
            const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
            return (
              <g key={s.name}>
                <path class={`line ${s.cls}`} d={d} />
                {pts.map((p, i) =>
                  showDots || p.bad ? (
                    <circle key={i} class={`dot ${s.cls}f ${p.bad ? "bad" : ""}`} cx={sx(p.x)} cy={sy(p.y)} r={p.bad ? 4.5 : 3.5} />
                  ) : null,
                )}
              </g>
            );
          })}
          {hp && (
            <g>
              <line class="cross" x1={sx(hp.x)} x2={sx(hp.x)} y1={pad.t} y2={pad.t + ih} />
              <circle class={`dot ${props.series[hover!.si]!.cls}f`} cx={sx(hp.x)} cy={sy(hp.y)} r={6} />
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div class="tip" style={{ left: `${Math.min(Math.max(sx(hp.x), 90), width - 90)}px`, top: `${Math.max(0, sy(hp.y) - 52)}px` }}>
          {hp.tip}
        </div>
      )}
      {props.series.length > 1 && (
        <div class="legend">
          {props.series.map((s) => (
            <span key={s.name}>
              <i class={`c-${s.cls}`} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Proportional stacked bar with legend (labels carry identity, not color alone). */
export function StackBar(props: { parts: Array<{ key: string; label: string; value: number; cls: string }>; label: string }) {
  const total = props.parts.reduce((n, p) => n + p.value, 0);
  if (total === 0) return <div class="dim small">No tasks in this window.</div>;
  return (
    <div>
      <div class="stackbar" role="img" aria-label={`${props.label}: ${props.parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        {props.parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.key} class={p.cls} style={{ flexGrow: String(p.value), flexBasis: "0" }} title={`${p.label}: ${p.value}`} />
          ))}
      </div>
      <div class="legend">
        {props.parts.map((p) => (
          <span key={p.key} class={p.value === 0 ? "dim" : ""}>
            <i class={p.cls} />
            {p.label} <strong class="tnum">{fmtNum(p.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bars for small categorical counts. */
export function HBars(props: { rows: Array<{ label: string; value: number; tone?: "bad" | "good" | "warn"; display?: string }>; max?: number }) {
  const max = props.max ?? Math.max(1, ...props.rows.map((r) => r.value));
  if (props.rows.length === 0) return <div class="dim small">Nothing recorded.</div>;
  return (
    <div class="hbars">
      {props.rows.map((r) => (
        <div class="hbar" key={r.label}>
          <span class="ellipsis">{r.label}</span>
          <div class="track">
            <span class={r.tone ?? ""} style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span class="tnum">{r.display ?? r.value}</span>
        </div>
      ))}
    </div>
  );
}
