import type { SkillResult } from "./types.js";

/**
 * Wrap a skill in a try/catch so unexpected exceptions become
 * `{ ok: false, message }` results instead of taking down the bot.
 *
 * Callers (the manual chat trigger now, the Claude tool dispatcher later)
 * should always go through this rather than invoking skill functions raw —
 * skill modules deliberately stay free of cross-cutting concerns so they
 * remain unit-testable as plain async functions.
 */
export async function runSkill<P, R extends SkillResult>(
  name: string,
  params: P,
  fn: (params: P) => Promise<R>,
): Promise<SkillResult> {
  try {
    return await fn(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[skill ${name}] threw:`, err);
    return { ok: false, message: `${name} crashed: ${message}` };
  }
}
