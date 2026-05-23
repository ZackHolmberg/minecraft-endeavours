/**
 * Dashboard spike — confirm `blessed-contrib` renders cleanly on this
 * terminal BEFORE wiring real orchestrator data into a TUI.
 *
 * Per ROADMAP "In-terminal dashboard": this is Phase 0. One grid, a gauge
 * (stand-in for the 5h Pro window), and a log widget driven by setInterval.
 * If the box-drawing + percent bar render correctly, we know the lib choice
 * is safe and can move on to instrumenting the orchestrator (Phase 1).
 *
 * Run with:  npx tsx spikes/dashboard-spike.ts
 * Quit:      q  /  Esc  /  Ctrl+C
 *
 * The ambient `blessed-contrib` shim below lives inline only for the spike.
 * Phase 3 will move it to src/types/blessed-contrib.d.ts when the real
 * dashboard module is created. @types/blessed-contrib doesn't exist on
 * DefinitelyTyped (checked 2026-05-23), and @types/blessed covers the
 * Screen / Element surface we re-export here.
 */

import blessed from "blessed";
import contrib from "blessed-contrib";

// ─────────────────────────────────────────────────────────────────────────────
// Inline ambient shim for blessed-contrib (relocates to src/types/ in Phase 3).
// ─────────────────────────────────────────────────────────────────────────────

declare module "blessed-contrib" {
  import type { Widgets } from "blessed";

  interface GridOptions {
    rows: number;
    cols: number;
    screen: Widgets.Screen;
    dashboardMargin?: number;
    hideBorder?: boolean;
    color?: string;
  }

  type WidgetFactory<O, W> = (opts: O) => W;

  class Grid {
    constructor(options: GridOptions);
    set<O, W>(
      row: number,
      col: number,
      rowSpan: number,
      colSpan: number,
      widget: WidgetFactory<O, W>,
      opts?: O,
    ): W;
  }

  interface LogOptions {
    label?: string;
    bufferLength?: number;
    tags?: boolean;
    style?: Record<string, unknown>;
    fg?: string;
    selectedFg?: string;
    selectedBg?: string;
  }
  interface LogWidget extends Widgets.BlessedElement {
    log(message: string): void;
  }

  interface GaugeOptions {
    label?: string;
    percent?: number;
    stroke?: string;
    fill?: string;
    showLabel?: boolean;
  }
  interface GaugeWidget extends Widgets.BlessedElement {
    setData(percent: number): void;
  }

  const _default: {
    grid: typeof Grid;
    log: WidgetFactory<LogOptions, LogWidget>;
    gauge: WidgetFactory<GaugeOptions, GaugeWidget>;
  };
  export default _default;
  export const grid: typeof Grid;
  export const log: WidgetFactory<LogOptions, LogWidget>;
  export const gauge: WidgetFactory<GaugeOptions, GaugeWidget>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spike
// ─────────────────────────────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: "minecraft-endeavours dashboard spike",
});

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

const proGauge = grid.set(0, 0, 4, 6, contrib.gauge, {
  label: " 5h Pro window (stand-in) ",
  stroke: "green",
  fill: "white",
  percent: 0,
});

const logBox = grid.set(4, 0, 8, 12, contrib.log, {
  label: " Log (stand-in) ",
  bufferLength: 100,
  tags: true,
  fg: "white",
  selectedFg: "white",
  selectedBg: "blue",
});

// Placeholder filler in the top-right so the layout proves out two cells.
const statusBox = grid.set(0, 6, 4, 6, blessed.box, {
  label: " Status (stand-in) ",
  content:
    "\n  STATE   {green-fg}rendering spike{/}\n  POS     —\n  HP/FOOD —\n  TASK    confirm blessed-contrib draws on this terminal",
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "cyan" } },
});

const startedAt = Date.now();
let percent = 0;

const tick = setInterval(() => {
  percent = (percent + 7) % 101;
  proGauge.setData(percent);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  logBox.log(`{cyan-fg}[${elapsed}s]{/} tick — gauge=${percent}%`);

  screen.render();
}, 500);

screen.key(["q", "C-c", "escape"], () => {
  clearInterval(tick);
  screen.destroy();
  process.exit(0);
});

screen.render();

// Avoid the "unused" diagnostic for statusBox — keeps the spike honest about
// the three widgets it instantiates.
void statusBox;
