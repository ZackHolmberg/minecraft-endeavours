/** ScenarioCtx implementation: wires RCON + Tester + telemetry for one scenario. */
import type { Rcon } from "./rcon.js";
import { parseItemEntry, parsePos, stripDataPrefix } from "./snbt.js";
import { jobState, readEvents, taskState } from "./telemetry.js";
import type { Tester } from "./tester.js";
import type { Box, ScenarioCtx, Vec3 } from "./types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mc = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);
const fmt = (n: number) => (Number.isInteger(n) ? n + 0.5 : n);

export interface ProtectedBox {
  box: Box;
  label: string;
}

export class EvalContext implements ScenarioCtx {
  readonly protectedBoxes: ProtectedBox[] = [];
  /** Positions of protected blocks that changed type after protection was armed. */
  readonly brokenProtected = new Map<string, string>();
  armed = false;
  /** First/last block name per position changed after arming (placedBlocks). */
  private readonly changes = new Map<string, { pos: Vec3; first: string; last: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scratch: Record<string, any> = {};
  /** Epoch ms of the first say(); null until then. */
  firstSayAt: number | null = null;
  lastSayAt: number | null = null;
  /** Set by the runner's poller when check() passes; lets waitForDone return early. */
  successFlag = false;
  private offBlock: () => void;

  constructor(
    readonly bot: string,
    readonly tester: string,
    readonly site: Vec3,
    readonly signal: AbortSignal,
    private readonly r: Rcon,
    private readonly t: Tester,
    private readonly eventsPath: string,
  ) {
    this.offBlock = t.onBlockChange((c) => {
      if (!this.armed) return;
      const k = `${c.pos.x},${c.pos.y},${c.pos.z}`;
      const prev = this.changes.get(k);
      if (prev) prev.last = c.to;
      else this.changes.set(k, { pos: c.pos, first: c.from, last: c.to });
      for (const p of this.protectedBoxes)
        if (inBox(c.pos, p.box)) this.brokenProtected.set(`${c.pos.x},${c.pos.y},${c.pos.z}`, `${c.from}->${c.to}@${c.pos.x},${c.pos.y},${c.pos.z}`);
    });
  }

  dispose(): void {
    this.offBlock();
  }

  // ── raw ──
  rcon(cmd: string): Promise<string> {
    return this.r.command(cmd);
  }
  async sleep(ms: number): Promise<void> {
    if (this.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  at(dx: number, dy: number, dz: number): Vec3 {
    return { x: this.site.x + dx, y: this.site.y + dy, z: this.site.z + dz };
  }

  // ── setup ──
  async give(player: string, item: string, count: number): Promise<void> {
    await this.rcon(`give ${player} ${mc(item)} ${count}`);
  }
  async tp(player: string, pos: Vec3): Promise<void> {
    await this.rcon(`tp ${player} ${fmt(pos.x)} ${pos.y} ${fmt(pos.z)}`);
  }
  async setBlock(pos: Vec3, block: string): Promise<void> {
    await this.rcon(`setblock ${pos.x} ${pos.y} ${pos.z} ${mc(block)}`);
  }
  async fill(box: Box, block: string): Promise<void> {
    const { min, max } = box;
    const vol = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
    if (vol > 30000) {
      // split along y (cheapest axis to halve)
      const mid = Math.floor((min.y + max.y) / 2);
      await this.fill({ min, max: { ...max, y: mid } }, block);
      await this.fill({ min: { ...min, y: mid + 1 }, max }, block);
      return;
    }
    await this.rcon(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${mc(block)}`);
  }
  async placeFeature(feature: string, pos: Vec3): Promise<void> {
    await this.rcon(`place feature ${mc(feature)} ${pos.x} ${pos.y} ${pos.z}`);
  }
  async summon(entity: string, pos: Vec3, nbt?: string): Promise<string> {
    const name = entity.replace(/^minecraft:/, "");
    const tag = `eval_${name}`;
    const inner = nbt ? nbt.trim().replace(/^\{/, "").replace(/\}$/, "") : "";
    await this.rcon(`summon ${mc(entity)} ${fmt(pos.x)} ${pos.y} ${fmt(pos.z)} {Tags:["${tag}"]${inner ? "," + inner : ""}}`);
    return tag;
  }
  protect(box: Box, label: string): void {
    this.protectedBoxes.push({ box, label });
  }
  async setTime(ticks: number): Promise<void> {
    await this.rcon(`time set ${ticks}`);
  }
  /** Y of the first standable air cell above the ground at (x,z), or site.y if unknown. */
  async surface(x: number, z: number): Promise<number> {
    const y = this.t.surfaceY(x, z);
    return y === null ? this.site.y : y + 1;
  }

  // ── player actions ──
  async say(message: string): Promise<void> {
    const now = Date.now();
    this.firstSayAt ??= now;
    this.lastSayAt = now;
    // Scenarios address the bot as "steve"; the router only knows the full username
    // (alias stripping covers `_ai|_bot|_npc` suffixes only, so "steve" would not route to Steve_v2).
    this.t.say(message.replace(/\bsteve\b(?!_)/gi, this.bot));
  }

  waitForBotChat(re?: RegExp, timeoutMs = 30_000): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        off();
        this.signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const off = this.t.onChat((l) => {
        if (!re || re.test(l.text)) done(l.text);
      });
      const timer = setTimeout(() => done(null), timeoutMs);
      const onAbort = () => done(null);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async waitForDone(opts: { quietMs?: number; since?: number } = {}): Promise<void> {
    const quiet = opts.quietMs ?? 8000;
    const since = opts.since ?? this.lastSayAt ?? Date.now();
    while (!this.signal.aborted && !this.successFlag) {
      const events = readEvents(this.eventsPath);
      const st = taskState(events, since);
      const job = jobState(events);
      if (st.ends > 0 && !st.running && !job.running) {
        // a job_end queues a follow-up Haiku task: the quiet window also runs from the job's end
        const last = Math.max(st.lastStartAt ?? 0, st.lastEndAt ?? 0, job.lastAt);
        // no task started since the job ended: its follow-up may still be spinning up (cold SDK spawn), wait longer
        const followUpPending = job.lastAt > (st.lastStartAt ?? 0);
        if (Date.now() - last >= (followUpPending ? Math.max(quiet, 30_000) : quiet)) return;
      }
      await sleep(1000);
    }
  }

  // ── state queries ──
  /**
   * `data get` truncates long lists in its feedback (silently dropping items), so read entries one
   * by one: <path>[0], [1], ... until "Found no elements".
   */
  private async readItems(target: string, listPath: string, slots?: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    const add = (out: string) => {
      const it = parseItemEntry(out);
      if (it) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
    };
    if (slots) for (const sl of slots) add(await this.rcon(`data get ${target} ${sl}`));
    else
      for (let i = 0; i < 80; i++) {
        const out = await this.rcon(`data get ${target} ${listPath}[${i}]`);
        if (!parseItemEntry(out)) break;
        add(out);
      }
    return m;
  }
  async inventory(player: string): Promise<Map<string, number>> {
    const inv = await this.readItems(`entity ${player}`, "Inventory");
    const eq = await this.readItems(
      `entity ${player}`,
      "",
      ["head", "chest", "legs", "feet", "offhand", "body"].map((s) => `equipment.${s}`),
    );
    for (const [k, n] of eq) inv.set(k, (inv.get(k) ?? 0) + n);
    return inv;
  }
  containerItems(pos: Vec3): Promise<Map<string, number>> {
    return this.readItems(`block ${pos.x} ${pos.y} ${pos.z}`, "Items");
  }
  async position(player: string): Promise<Vec3> {
    const p = parsePos(await this.rcon(`data get entity ${player} Pos`));
    if (!p) throw new Error(`no position for ${player} (offline?)`);
    return p;
  }
  async blockAt(pos: Vec3): Promise<string> {
    let n = this.t.blockNameAt(pos);
    if (n === null) {
      await this.loadNear(pos);
      n = this.t.blockNameAt(pos);
    }
    return n ?? "unloaded";
  }
  async countBlocks(box: Box, name: string | RegExp): Promise<number> {
    let n = this.t.countBlocks(box, name);
    if (n === null) {
      await this.loadNear(box.min);
      n = this.t.countBlocks(box, name);
    }
    return n ?? -1;
  }
  async entityExists(selector: string): Promise<boolean> {
    return /passed/i.test(await this.rcon(`execute if entity ${selector}`));
  }
  get succeeded(): boolean {
    return this.successFlag;
  }
  async placedBlocks(b: Box): Promise<number> {
    let n = 0;
    for (const c of this.changes.values()) if (inBox(c.pos, b) && REPLACEABLE.test(c.first) && !REPLACEABLE.test(c.last)) n++;
    return n;
  }
  async foodLevel(player: string): Promise<number> {
    return numData(await this.rcon(`data get entity ${player} foodLevel`));
  }
  async health(player: string): Promise<number> {
    return numData(await this.rcon(`data get entity ${player} Health`));
  }
  async timeOfDay(): Promise<number> {
    return Number(/(\d+)/.exec(await this.rcon("time query daytime"))?.[1] ?? -1);
  }
  async gameTime(): Promise<number> {
    return Number(/(\d+)/.exec(await this.rcon("time query gametime"))?.[1] ?? -1);
  }
  eventCount(kind: string, where?: (e: Record<string, unknown>) => boolean): number {
    return readEvents(this.eventsPath).filter((e) => e.kind === kind && (!where || where(e as unknown as Record<string, unknown>))).length;
  }
  get botChats(): readonly string[] {
    return this.t.chats.map((l) => l.text);
  }

  /** Last resort when a chunk isn't loaded in the Tester's world: hop there, wait, hop back. */
  private async loadNear(pos: Vec3): Promise<void> {
    const back = await this.position(this.tester).catch(() => null);
    await this.rcon(`tp ${this.tester} ${fmt(pos.x)} ${pos.y + 3} ${fmt(pos.z)}`);
    for (let i = 0; i < 20 && this.t.blockNameAt(pos) === null; i++) await sleep(500);
    if (back) await this.rcon(`tp ${this.tester} ${back.x} ${back.y} ${back.z}`);
  }
}

/** Block names that count as "nothing there" for placedBlocks. */
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|snow|dead_bush|seagrass|tall_seagrass|vine|poppy|dandelion|fire|light|[a-z_]*flower|[a-z_]*tulip)$/;

function numData(out: string): number {
  const m = /data: (-?[\d.]+)/.exec(out);
  return m ? Number(m[1]) : -1;
}

export function inBox(p: Vec3, b: Box): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

export { stripDataPrefix };
