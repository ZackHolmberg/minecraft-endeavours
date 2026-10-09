import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConsoleRequest, ConsoleResponse } from "../../../shared/api.js";
import { api, errorMessage } from "../lib/api.js";
import { useFetch } from "../lib/hooks.js";
import { useStore } from "../lib/store.js";
import { status } from "../lib/status.js";
import { fmtTime } from "../lib/format.js";
import { Alert, Card, Skeleton } from "../components/ui.js";
import { ISend } from "../components/icons.js";

const QUICK = ["list", "time set day", "weather clear", "save-all", "difficulty", "seed", "tps", "whitelist list", "gamerule keepInventory true"];

interface Entry extends ConsoleResponse {
  error?: boolean;
  pending?: boolean;
}

export function Console() {
  const hist = useFetch<ConsoleResponse[]>("/api/console/history");
  const st = useStore(status);
  const [local, setLocal] = useState<Entry[]>([]);
  const [cmd, setCmd] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);

  // Transcript oldest → newest: server history (newest-first) reversed, then this session's.
  const entries: Entry[] = useMemo(() => {
    const server = [...(hist.data ?? [])].reverse();
    const seen = new Set(server.map((e) => `${e.at}|${e.command}`));
    return [...server, ...local.filter((e) => e.pending || e.error || !seen.has(`${e.at}|${e.command}`))];
  }, [hist.data, local]);

  // Recall list for ↑/↓: unique commands, newest first.
  const recall = useMemo(() => {
    const out: string[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const c = entries[i]!.command;
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }, [entries]);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [entries.length]);

  const valid = cmd.trim().length > 0 && cmd.length <= 256 && !/[\r\n]/.test(cmd);
  const serverDown = st.data && st.data.server.state !== "running";

  async function send(raw: string) {
    const command = raw.trim().replace(/^\//, "");
    if (!command || command.length > 256) return;
    const at = Date.now();
    setLocal((l) => [...l, { command, output: "", at, pending: true }]);
    setCmd("");
    setCursor(null);
    try {
      const body: ConsoleRequest = { command };
      const res = await api.post<ConsoleResponse>("/api/console", body);
      setLocal((l) => l.map((e) => (e.at === at && e.pending ? { ...res } : e)));
    } catch (e) {
      setLocal((l) => l.map((x) => (x.at === at && x.pending ? { command, output: errorMessage(e), at, error: true } : x)));
    }
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowUp") {
      if (recall.length === 0) return;
      e.preventDefault();
      const next = cursor === null ? 0 : Math.min(recall.length - 1, cursor + 1);
      if (cursor === null) setDraft(cmd);
      setCursor(next);
      setCmd(recall[next]!);
    } else if (e.key === "ArrowDown") {
      if (cursor === null) return;
      e.preventDefault();
      const next = cursor - 1;
      if (next < 0) {
        setCursor(null);
        setCmd(draft);
      } else {
        setCursor(next);
        setCmd(recall[next]!);
      }
    }
  }

  function reuse(c: string) {
    setCmd(c);
    setCursor(null);
    inputRef.current?.focus();
  }

  return (
    <div class="stack">
      <Alert tone="warn" title="Full server permissions">
        Commands run as the server console — op-level, no confirmation, no undo. Everything you run here is audited.
      </Alert>
      {serverDown && <Alert tone="info">The server is {st.data!.server.state}; commands will fail until it's running.</Alert>}
      <Card title="RCON console">
        <div class="chips" role="group" aria-label="Quick commands" style={{ marginBottom: "10px" }}>
          {QUICK.map((q) => (
            <button key={q} class="chip" type="button" onClick={() => reuse(q)} title="Put in the input (tap Send to run)">
              {q}
            </button>
          ))}
        </div>
        {hist.data === null && !hist.error ? (
          <Skeleton lines={5} />
        ) : (
          <div class="terminal term-mid" ref={termRef} role="log" aria-label="Console transcript" aria-live="polite">
            {hist.error && <div class="ln err">Couldn't load history: {hist.error}</div>}
            {entries.length === 0 && <div class="ln dim">No commands yet. Try “list”.</div>}
            {entries.map((e) => (
              <div class="entry" key={`${e.at}-${e.command}`}>
                <span class="at">{fmtTime(e.at)}</span>
                <button
                  type="button"
                  class="cmd"
                  onClick={() => reuse(e.command)}
                  title="Tap to reuse"
                  style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" }}
                >
                  {e.command}
                </button>
                {e.pending ? (
                  <div class="ln dim">…</div>
                ) : (
                  <div class={`ln ${e.error ? "err" : e.output ? "" : "dim"}`}>{e.output || "(no output)"}</div>
                )}
              </div>
            ))}
          </div>
        )}
        <form
          class="console-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void send(cmd);
          }}
        >
          <span class="prompt" aria-hidden="true">/</span>
          <label for="console-cmd" class="sr-only">Command</label>
          <input
            id="console-cmd"
            ref={inputRef}
            class="input mono grow"
            value={cmd}
            maxLength={256}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            enterKeyHint="send"
            placeholder="say hello"
            onInput={(e) => {
              setCmd((e.target as HTMLInputElement).value.replace(/[\r\n]/g, ""));
              setCursor(null);
            }}
            onKeyDown={onKey}
          />
          <button class="btn primary" type="submit" disabled={!valid} aria-label="Send command">
            <ISend /> <span class="only-desktop">Send</span>
          </button>
        </form>
        <p class="small dim" style={{ marginTop: "6px" }}>↑/↓ recall previous commands · tap a command above to reuse it</p>
      </Card>
    </div>
  );
}
