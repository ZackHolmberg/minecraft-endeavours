/**
 * Forgiving lookups for item and block IDs.
 *
 * The architectural rule is "vagueness is resolved in the model, not the
 * skill layer" — but two cheap mechanical accommodations compound to a much
 * better experience:
 *
 *   1. **Normalize on entry.** `"Diamond Sword"` and `"diamond sword"` and
 *      `"  diamond_sword  "` all resolve to `"diamond_sword"` — the player
 *      doesn't talk in snake_case, and the model occasionally forgets. The
 *      normalization is purely lexical: trim, lowercase, spaces-to-
 *      underscores. No semantic interpretation.
 *
 *   2. **Did-you-mean on miss.** When a lookup fails, surface a small
 *      ranked list of nearby IDs from the registry so the model can adapt
 *      in one round-trip instead of guessing blind. Ranking favors prefix
 *      matches, then suffix matches, then any substring; ties broken by
 *      shorter name. For `"iron"` the model sees the iron family right at
 *      the top and picks the right one for the context (`raw_iron` for
 *      smelting, `iron_ingot` for crafting, etc.).
 */

import type { Bot } from "mineflayer";

type ItemData = { id: number; name: string; displayName?: string };
type BlockData = { id: number; name: string; displayName?: string };

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

export interface Resolved<T> {
  ok: true;
  data: T;
  normalized: string;
}

export interface NotResolved {
  ok: false;
  /** Free-form message tail; callers prepend their own context. */
  message: string;
}

export function resolveItem(bot: Bot, raw: string): Resolved<ItemData> | NotResolved {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, message: "is required" };
  }
  const normalized = normalizeName(raw);
  const data = bot.registry.itemsByName[normalized] as ItemData | undefined;
  if (data) return { ok: true, data, normalized };
  return {
    ok: false,
    message: `unknown item "${raw}"${suggestionTail(Object.keys(bot.registry.itemsByName), normalized)}`,
  };
}

export function resolveBlock(bot: Bot, raw: string): Resolved<BlockData> | NotResolved {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, message: "is required" };
  }
  const normalized = normalizeName(raw);
  const data = bot.registry.blocksByName[normalized] as BlockData | undefined;
  if (data) return { ok: true, data, normalized };
  return {
    ok: false,
    message: `unknown block "${raw}"${suggestionTail(Object.keys(bot.registry.blocksByName), normalized)}`,
  };
}

const MAX_SUGGESTIONS = 5;

function suggestionTail(allKeys: string[], query: string): string {
  if (query.length === 0) return "";
  const matches = allKeys.filter((k) => k.includes(query));
  if (matches.length === 0) return "";
  matches.sort((a, b) => {
    const ap = a.startsWith(query) ? 0 : a.endsWith(query) ? 1 : 2;
    const bp = b.startsWith(query) ? 0 : b.endsWith(query) ? 1 : 2;
    if (ap !== bp) return ap - bp;
    return a.length - b.length;
  });
  const top = matches.slice(0, MAX_SUGGESTIONS);
  const tail = matches.length > MAX_SUGGESTIONS ? ", …" : "";
  return ` (did you mean: ${top.join(", ")}${tail}?)`;
}
