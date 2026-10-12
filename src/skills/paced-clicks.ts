import type { Bot } from "mineflayer";

/**
 * Run `fn` with a short pause after every `bot.clickWindow`.
 *
 * mineflayer's `bot.craft` fires its window clicks back to back and only waits
 * for *a* slot update, not for the server to have applied that click. On 1.21
 * (state-id + hashed-slot protocol) a table (3x3) craft then loses the race
 * with the server's own processing: the grid is incomplete when the result
 * slot is clicked, the server answers with a full resync, and the ingredients
 * come back with no output ("crafted 1 wooden_pickaxe" but nothing in the
 * inventory). Measured on the test server: 0/3 crafts at 0 ms spacing, 3/3 at
 * 60-150 ms. The result item can still land a few hundred ms after `craft`
 * resolves, so callers verify by inventory delta with a short settle wait.
 */
export const CLICK_PACE_MS = 120;

type ClickFn = (...args: unknown[]) => Promise<unknown>;
/** Per-bot patch state: overlapping calls share ONE wrapper (a naive save/restore leaks it when calls finish out of order). */
const active = new WeakMap<Bot, { original: ClickFn; depth: number; paceMs: number }>();

export async function withPacedClicks<T>(bot: Bot, fn: () => Promise<T>, paceMs: number = CLICK_PACE_MS): Promise<T> {
  const holder = bot as unknown as { clickWindow: ClickFn };
  let st = active.get(bot);
  if (st) {
    st.depth += 1;
    st.paceMs = Math.max(st.paceMs, paceMs);
  } else {
    const original = holder.clickWindow;
    const fresh = { original, depth: 1, paceMs };
    st = fresh;
    active.set(bot, fresh);
    holder.clickWindow = async (...args: unknown[]) => {
      const r = await original.apply(bot, args);
      await new Promise((resolve) => setTimeout(resolve, fresh.paceMs));
      return r;
    };
  }
  const state = st;
  try {
    return await fn();
  } finally {
    state.depth -= 1;
    if (state.depth === 0) {
      holder.clickWindow = state.original;
      active.delete(bot);
    }
  }
}
