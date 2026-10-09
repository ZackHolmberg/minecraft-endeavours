import type { ActionDef, ActionId, JobSummary } from "../../../shared/api.js";
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
};

/** Confirm (when the server says so), POST, and toast the outcome. */
export async function runAction(def: Pick<ActionDef, "id" | "label" | "description" | "confirm">): Promise<JobSummary | null> {
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
