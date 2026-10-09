/**
 * The "Tester": a mineflayer client that plays the human. It stays connected
 * across scenarios, so it (a) sends the chat lines, (b) records the bot's chat,
 * (c) keeps the scenario site's chunks loaded so blockAt/countBlocks work, and
 * (d) reports block changes inside protected boxes.
 */
import mineflayer, { type Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Box, Vec3 as V } from "./types.js";

export interface ChatLine {
  at: number;
  text: string;
}

export interface BlockChange {
  pos: V;
  from: string;
  to: string;
}

export class Tester {
  bot: Bot | null = null;
  /** Bot chat lines observed since last resetChats(). */
  chats: ChatLine[] = [];
  private chatListeners: Array<(l: ChatLine) => void> = [];
  private blockListeners: Array<(c: BlockChange) => void> = [];
  private lastKick = "";
  /** Epoch ms of the last connect attempt (Paper throttles same-IP logins within 4s). */
  connectedAt = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly version: string,
    readonly username: string,
    private readonly botName: string,
    /** Walk to nearby dropped items like a human (Tester: yes; --dry stand-in bot: no). */
    private readonly walkItems = true,
  ) {}

  async connect(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.end();
      } catch {
        /* ignore */
      }
    }
    this.connectedAt = Date.now();
    const bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      version: this.version,
      username: this.username,
      auth: "offline",
      checkTimeoutInterval: 60_000,
    });
    this.bot = bot;
    bot.on("kicked", (r) => {
      this.lastKick = JSON.stringify(r);
    });
    bot.on("error", () => {});
    bot.on("end", () => {
      if (this.bot === bot) this.bot = null;
    });
    bot.on("chat", (username, message) => {
      if (username === this.botName) this.onBotChat(message);
    });
    bot.on("whisper", (username, message) => {
      if (username === this.botName) this.onBotChat(message);
    });
    bot.on("blockUpdate", (oldBlock, newBlock) => {
      if (!oldBlock || !newBlock) return;
      if (oldBlock.name === newBlock.name) return;
      const c = {
        pos: { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z },
        from: oldBlock.name,
        to: newBlock.name,
      };
      for (const l of this.blockListeners) l(c);
    });
    // Human-like item pickup: walk over to dropped items within 6 blocks (a tossed item lands
    // a few blocks away; a real player would step onto it).
    const walker = setInterval(() => this.walkItems && this.pickupStep(bot), 150);
    bot.once("end", () => clearInterval(walker));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Tester spawn timeout (${this.lastKick})`)), 60_000);
      bot.once("spawn", () => {
        clearTimeout(t);
        resolve();
      });
      bot.once("end", () => {
        clearTimeout(t);
        reject(new Error(`Tester disconnected before spawn (${this.lastKick})`));
      });
    });
  }

  private pickupStep(bot: Bot): void {
    const me = bot.entity;
    if (!me) return;
    let best: { d: number; e: (typeof bot.entities)[string] } | null = null;
    for (const e of Object.values(bot.entities)) {
      if (e.name !== "item" || !e.position) continue;
      const d = Math.hypot(e.position.x - me.position.x, e.position.z - me.position.z);
      if (d < 6 && Math.abs(e.position.y - me.position.y) < 4 && (!best || d < best.d)) best = { d, e };
    }
    if (!best || best.d < 0.6) {
      bot.setControlState("forward", false);
      bot.setControlState("jump", false);
      return;
    }
    void bot.lookAt(best.e.position, true);
    bot.setControlState("forward", true);
    bot.setControlState("jump", best.e.position.y - me.position.y > 0.5);
  }

  get alive(): boolean {
    return !!this.bot?.entity;
  }

  private onBotChat(text: string): void {
    const line = { at: Date.now(), text };
    this.chats.push(line);
    for (const l of this.chatListeners) l(line);
  }

  resetChats(): void {
    this.chats = [];
  }

  onChat(fn: (l: ChatLine) => void): () => void {
    this.chatListeners.push(fn);
    return () => {
      this.chatListeners = this.chatListeners.filter((x) => x !== fn);
    };
  }

  onBlockChange(fn: (c: BlockChange) => void): () => void {
    this.blockListeners.push(fn);
    return () => {
      this.blockListeners = this.blockListeners.filter((x) => x !== fn);
    };
  }

  say(msg: string): void {
    this.bot?.chat(msg);
  }

  /** Block name at pos, or null if its chunk isn't loaded in the Tester's world. */
  blockNameAt(pos: V): string | null {
    const b = this.bot?.blockAt(new Vec3(pos.x, pos.y, pos.z));
    return b ? b.name : null;
  }

  /** Count blocks in box (null if any needed chunk is unloaded). */
  countBlocks(box: Box, name: string | RegExp): number | null {
    let n = 0;
    for (let x = box.min.x; x <= box.max.x; x++)
      for (let y = box.min.y; y <= box.max.y; y++)
        for (let z = box.min.z; z <= box.max.z; z++) {
          const nm = this.blockNameAt({ x, y, z });
          if (nm === null) return null;
          if (typeof name === "string" ? nm === name : name.test(nm)) n++;
        }
    return n;
  }

  /** Highest solid, non-foliage block y in column (null if unloaded). */
  surfaceY(x: number, z: number): number | null {
    for (let y = 318; y > -60; y--) {
      const nm = this.blockNameAt({ x, y, z });
      if (nm === null) return null;
      if (nm === "air" || nm === "cave_air" || nm === "void_air") continue;
      if (/leaves|_log$|_wood$|vine|snow$|grass$|fern|flower|poppy|dandelion|bush|mushroom|water|lava|kelp|seagrass|lily/.test(nm))
        continue;
      return y;
    }
    return null;
  }

  end(): void {
    try {
      this.bot?.end();
    } catch {
      /* ignore */
    }
  }
}
