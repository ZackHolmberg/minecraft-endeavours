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
  return raw.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
}

/**
 * Players say "sticks", "oak logs", "torches", "potatoes". Try the registry
 * key as given, then with a plural suffix stripped. Purely lexical — only
 * accepted if the singular is an actual registry key.
 */
function lookupWithPlural<T>(table: Record<string, T>, normalized: string): { data: T; key: string } | null {
  const direct = table[normalized];
  if (direct) return { data: direct, key: normalized };
  for (const suffix of ["es", "s"]) {
    if (normalized.endsWith(suffix)) {
      const key = normalized.slice(0, -suffix.length);
      const data = table[key];
      if (data) return { data, key };
    }
  }
  return null;
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
  const hit = lookupWithPlural(bot.registry.itemsByName as Record<string, ItemData>, normalized);
  if (hit) return { ok: true, data: hit.data, normalized: hit.key };
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
  const hit = lookupWithPlural(bot.registry.blocksByName as Record<string, BlockData>, normalized);
  if (hit) return { ok: true, data: hit.data, normalized: hit.key };
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
