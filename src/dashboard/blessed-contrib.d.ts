/**
 * Ambient shim for `blessed-contrib` — there is no @types/blessed-contrib on
 * DefinitelyTyped (checked 2026-05-23). Covers only the widgets the dashboard
 * actually uses (grid + log). Add to this if the dashboard grows to need
 * more (sparkline, table, gauge, etc.).
 *
 * @types/blessed already covers the Screen / Element / blessed.{box,list,...}
 * surface this file references.
 */

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
