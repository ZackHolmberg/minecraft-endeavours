/**
 * Per-bot reserved items: inventory the active job still needs (its plan's raw
 * materials and the intermediate inputs of its steps). Filler consumers such as
 * `pickFiller` (pillar escapes, mining water-escape) must not spend these.
 *
 * Why: in v2 regression t2.stone_pickaxe the bot dug a pit while gathering
 * cobblestone, then pillared out of it using that very cobblestone and the
 * craft failed with "need 3 cobblestone, have 2".
 *
 * Module-level and keyed by username (like the job runner registry) so skills
 * stay `(bot, params)`. A reserved count of `Infinity` means "all of it".
 * Ephemeral by design: set by the job runner on plan/replan, cleared at job end.
 */

const reserved = new Map<string, Map<string, number>>();

/** Replace this bot's reservations. */
export function setReserved(username: string, items: Record<string, number>): void {
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(items)) if (v > 0) m.set(k, v);
  if (m.size === 0) reserved.delete(username);
  else reserved.set(username, m);
}

export function clearReserved(username: string): void {
  reserved.delete(username);
}

/** How many of `item` must be kept (0 = free to use; Infinity = all). */
export function reservedCount(username: string, item: string): number {
  return reserved.get(username)?.get(item) ?? 0;
}

/** Copy of the current reservations (for logs/tests). */
export function reservedSnapshot(username: string): Record<string, number> {
  return Object.fromEntries(reserved.get(username) ?? []);
}

/** How many of `item` the bot may spend given `held` in inventory. */
export function spendable(username: string, item: string, held: number): number {
  return Math.max(0, held - reservedCount(username, item));
}
