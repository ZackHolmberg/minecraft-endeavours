import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { LogSource } from "../../../shared/api.js";
import { useChannel, useFetch } from "../lib/hooks.js";
import { Card, ErrorState, Segmented, Skeleton } from "../components/ui.js";
import { IDown, IPause, IPlay, ITrash } from "../components/icons.js";

const MAX_LINES = 5000;

export function lineClass(l: string): string {
  if (/\b(ERROR|SEVERE|FATAL|Exception|failed|✗)\b/i.test(l)) return "err";
  if (/\b(WARN|WARNING)\b/.test(l)) return "warn";
  if (/\b(succeeded|Done|✓|connected)\b/.test(l)) return "ok";
  return "";
}

export function Logs() {
  const [source, setSource] = useState<LogSource>("bot");
  return (
    <div class="stack">
      <Segmented
        label="Log source"
        value={source}
        onChange={setSource}
        options={[
          { value: "bot", label: "Bot log" },
          { value: "server", label: "Server log" },
        ]}
      />
      <LogView key={source} source={source} />
    </div>
  );
}

function LogView({ source }: { source: LogSource }) {
  const initial = useFetch<{ lines: string[] }>(`/api/logs/${source}?lines=500`);
  const [lines, setLines] = useState<string[]>([]);
  const [held, setHeld] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (initial.data) setLines((l) => [...initial.data!.lines, ...l].slice(-MAX_LINES));
  }, [initial.data]);

  useChannel(`logs:${source}`, (m) => {
    if (m.type !== "log" || m.source !== source) return;
    if (pausedRef.current) setHeld((h) => [...h, ...m.lines].slice(-MAX_LINES));
    else setLines((l) => [...l, ...m.lines].slice(-MAX_LINES));
  });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return lines.filter((l) => (!q || l.toLowerCase().includes(q)) && (!onlyProblems || lineClass(l) === "err" || lineClass(l) === "warn"));
  }, [lines, filter, onlyProblems]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown, follow]);

  function resume() {
    setLines((l) => [...l, ...held].slice(-MAX_LINES));
    setHeld([]);
    setPaused(false);
    setFollow(true);
  }

  const q = filter.trim();
  return (
    <Card
      title={source === "bot" ? "Bot log" : "Server log"}
      actions={
        <div class="row">
          <button class={`btn sm ${paused ? "primary" : ""}`} onClick={() => (paused ? resume() : setPaused(true))} aria-pressed={paused}>
            {paused ? <IPlay /> : <IPause />}
            {paused ? `Resume${held.length ? ` (${held.length})` : ""}` : "Pause"}
          </button>
          <button class="btn sm icon ghost" onClick={() => setLines([])} aria-label="Clear view" title="Clear view">
            <ITrash />
          </button>
        </div>
      }
    >
      <div class="row wrap" style={{ marginBottom: "10px" }}>
        <label for="log-filter" class="sr-only">Filter lines</label>
        <input id="log-filter" class="input grow" style={{ flexBasis: "220px" }} type="search" placeholder="Filter…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <label class="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems((e.target as HTMLInputElement).checked)} />
          Warnings &amp; errors
        </label>
        <label class="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
          Auto-scroll
        </label>
      </div>
      {initial.data === null && !initial.error ? (
        <Skeleton lines={8} />
      ) : initial.error && lines.length === 0 ? (
        <ErrorState error={initial.error} onRetry={initial.reload} />
      ) : (
        <div
          class="terminal term-tall"
          ref={ref}
          role="log"
          aria-label={`${source} log`}
          onScroll={(e) => {
            const el = e.currentTarget as HTMLDivElement;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atBottom !== follow) setFollow(atBottom);
          }}
        >
          {shown.length === 0 ? (
            <div class="ln dim">{lines.length === 0 ? (source === "bot" ? "No bot log yet — is the bot running?" : "No server log lines yet.") : "No lines match the filter."}</div>
          ) : (
            shown.map((l, i) => (
              <div class={`ln ${lineClass(l)}`} key={i}>
                {q ? highlight(l, q) : l}
              </div>
            ))
          )}
        </div>
      )}
      <div class="row between small dim" style={{ marginTop: "8px" }}>
        <span class="tnum">
          {shown.length.toLocaleString()} {q || onlyProblems ? `of ${lines.length.toLocaleString()} ` : ""}lines{paused ? " · paused" : ""}
        </span>
        {!follow && (
          <button class="btn sm" onClick={() => setFollow(true)}>
            <IDown /> Latest
          </button>
        )}
      </div>
    </Card>
  );
}

function highlight(line: string, q: string) {
  const i = line.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return line;
  return (
    <>
      {line.slice(0, i)}
      <mark>{line.slice(i, i + q.length)}</mark>
      {line.slice(i + q.length)}
    </>
  );
}
