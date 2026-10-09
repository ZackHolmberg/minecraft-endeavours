import type { ActionDef, ActionId, JobSummary, WorldNewRequest } from "../../../shared/api.js";
import { api, errorMessage, HttpError } from "./api.js";
import { confirm, toast } from "../components/ui.js";
import { refreshStatus } from "./status.js";
import { href } from "./router.js";
import { h } from "preact";

export const ACTION_LABEL: Record<ActionId, string> = {
  "server.start": "Start server",
  "server.stop": "Stop server",
  "server.restart": "Restart server",
  "bot.start": "Start bot",
  "bot.stop": "Stop bot",
  "bot.restart": "Restart bot",
  "world.save": "Save world",
  "backup.run": "Run backup",
  "world.new": "New world",
};

/** Confirm (when the server says so), POST, and toast the outcome. `world.new` takes input: use startNewWorld. */
export async function runAction(def: Pick<ActionDef, "id" | "label" | "description" | "confirm">): Promise<JobSummary | null> {
  if (def.id === "world.new") return null;
  if (def.confirm) {
    const ok = await confirm({
      title: `${def.label}?`,
      body: def.description,
      confirmLabel: def.label,
      danger: /stop|restart/.test(def.id),
    });
    if (!ok) return null;
  }
  try {
    const job = await api.post<JobSummary>(`/api/actions/${def.id}`);
    toast(h("span", null, `${def.label} started · `, h("a", { href: href(`/jobs/${job.id}`) }, "View output")));
    refreshStatus();
    return job;
  } catch (e) {
    const msg = e instanceof HttpError && e.code === "busy" ? "Another job in this group is still running." : errorMessage(e);
    toast(`${def.label} failed: ${msg}`, "bad", 7000);
    return null;
  }
}

export const NEW_WORLD_PHRASE: WorldNewRequest["confirm"] = "NEW WORLD";
/** Mirrors the server's seed rule (api.ts WorldNewRequest). */
export const SEED_RE = /^-?[A-Za-z0-9_ ]{1,32}$/;

/** Typed confirmation, then POST /api/actions/world.new. `seed` empty = random. */
export async function startNewWorld(seed: string): Promise<JobSummary | null> {
  const s = seed.trim();
  const ok = await confirm({
    title: "Start a new world?",
    body: h(
      "div",
      { class: "stack tight" },
      h("p", null, s ? h("span", null, "Seed ", h("code", null, s), ".") : "Random seed.", " Everyone online will be disconnected while the server restarts, and the bot forgets everything it knew about the old world."),
      h("p", null, "The current world and the bot's memory are moved into archives, not deleted."),
    ),
    confirmLabel: "Start new world",
    danger: true,
    requireText: NEW_WORLD_PHRASE,
  });
  if (!ok) return null;
  try {
    const body: WorldNewRequest = s ? { seed: s, confirm: NEW_WORLD_PHRASE } : { confirm: NEW_WORLD_PHRASE };
    const job = await api.post<JobSummary>("/api/actions/world.new", body);
    toast("New world started — follow along below.");
    refreshStatus();
    return job;
  } catch (e) {
    const msg = e instanceof HttpError && e.code === "busy" ? "Another job is still running." : errorMessage(e);
    toast(`New world failed to start: ${msg}`, "bad", 8000);
    return null;
  }
}
