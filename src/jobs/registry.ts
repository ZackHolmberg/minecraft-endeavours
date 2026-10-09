/**
 * Per-bot JobRunner registry (same pattern as `registerAgent` / `registerBotState`).
 * Kept dependency-free so skills/registry.ts and agent code can look up the
 * runner without importing the executor stack.
 */
import type { JobRunner } from "./runner.js";

const runners = new Map<string, JobRunner>();

export function getJobRunner(username: string): JobRunner | null {
  return runners.get(username) ?? null;
}

/** Replaces (and disposes) any existing runner for the username. */
export async function registerJobRunner(username: string, runner: JobRunner): Promise<void> {
  const old = runners.get(username);
  runners.set(username, runner);
  if (old && old !== runner) await old.dispose();
}

export async function unregisterJobRunner(username: string): Promise<void> {
  const old = runners.get(username);
  runners.delete(username);
  if (old) await old.dispose();
}
