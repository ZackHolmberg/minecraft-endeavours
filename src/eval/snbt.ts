/** Tiny tolerant SNBT parser + item-count helpers for RCON `data get` output. */

export type Snbt = string | number | boolean | Snbt[] | { [k: string]: Snbt };

export function parseSnbt(src: string): Snbt {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const value = (): Snbt => {
    ws();
    const c = src[i];
    if (c === "{") return compound();
    if (c === "[") return list();
    if (c === '"' || c === "'") return str();
    return bare();
  };
  const str = (): string => {
    const q = src[i++]!;
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") i++;
      out += src[i++];
    }
    i++;
    return out;
  };
  const bare = (): Snbt => {
    const st = i;
    while (i < src.length && !/[,\]}:]/.test(src[i]!)) i++;
    const raw = src.slice(st, i).trim();
    if (raw === "true") return true;
    if (raw === "false") return false;
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[bslfdBSLFD]?$/.exec(raw);
    return m ? Number(m[1]) : raw;
  };
  const list = (): Snbt[] => {
    i++; // [
    const out: Snbt[] = [];
    ws();
    // typed arrays like [I; 1, 2]
    if (/^[BIL];/.test(src.slice(i, i + 2))) i += 2;
    for (;;) {
      ws();
      if (i >= src.length) return out;
      if (src[i] === "]") {
        i++;
        return out;
      }
      out.push(value());
      ws();
      if (src[i] === ",") i++;
    }
  };
  const compound = (): { [k: string]: Snbt } => {
    i++; // {
    const out: { [k: string]: Snbt } = {};
    for (;;) {
      ws();
      if (i >= src.length) return out;
      if (src[i] === "}") {
        i++;
        return out;
      }
      let key: string;
      if (src[i] === '"' || src[i] === "'") key = str();
      else {
        const st = i;
        while (i < src.length && src[i] !== ":") i++;
        key = src.slice(st, i).trim();
      }
      ws();
      i++; // :
      out[key] = value();
      ws();
      if (src[i] === ",") i++;
    }
  };
  return value();
}

/** Strip the "X has the following ... data: " prefix RCON adds. */
export function stripDataPrefix(out: string): string | null {
  const m = /data: ([\s\S]*)$/.exec(out.trim());
  return m ? m[1]! : null;
}

function addItem(map: Map<string, number>, v: Snbt): void {
  if (typeof v !== "object" || Array.isArray(v) || v === null) return;
  const id = v.id;
  if (typeof id !== "string") return;
  const count = typeof v.count === "number" ? v.count : typeof v.Count === "number" ? v.Count : 1;
  const name = id.replace(/^minecraft:/, "");
  map.set(name, (map.get(name) ?? 0) + count);
}

/** Item list (Inventory / block Items) → name → total count. */
export function countItems(listOut: string): Map<string, number> {
  const map = new Map<string, number>();
  const body = stripDataPrefix(listOut);
  if (body === null) return map;
  const v = parseSnbt(body);
  if (Array.isArray(v)) for (const it of v) addItem(map, it);
  return map;
}

/** `data get entity X equipment` (compound slot → item) → name → count. */
export function countEquipment(out: string): Map<string, number> {
  const map = new Map<string, number>();
  const body = stripDataPrefix(out);
  if (body === null) return map;
  const v = parseSnbt(body);
  if (typeof v === "object" && !Array.isArray(v)) for (const it of Object.values(v)) addItem(map, it);
  return map;
}

export function mergeCounts(...maps: Array<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of maps) for (const [k, n] of m) out.set(k, (out.get(k) ?? 0) + n);
  return out;
}

export function parsePos(out: string): { x: number; y: number; z: number } | null {
  const body = stripDataPrefix(out);
  if (body === null) return null;
  const v = parseSnbt(body);
  if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number"))
    return { x: v[0] as number, y: v[1] as number, z: v[2] as number };
  return null;
}
