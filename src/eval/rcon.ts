/**
 * Minimal Source-RCON client (Minecraft flavour). Commands are serialized.
 * Large (multi-packet, >4096 byte) responses are reassembled.
 */
import { createConnection, type Socket } from "node:net";

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;

interface Packet {
  id: number;
  type: number;
  body: string;
}

function encode(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

export class Rcon {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private waiters: Array<(p: Packet) => void> = [];
  private queued: Packet[] = [];
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly host: string,
    readonly port: number,
    private readonly password: string,
  ) {}

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    this.close();
    const sock = createConnection({ host: this.host, port: this.port });
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.queued = [];
    sock.on("data", (d) => this.onData(d));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("rcon connect timeout")), timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      sock.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const id = this.nextId++;
    sock.write(encode(id, TYPE_AUTH, this.password));
    // Server may send an empty RESPONSE packet first, then the auth reply.
    for (;;) {
      const p = await this.read(timeoutMs);
      if (p.type === TYPE_COMMAND || p.type === TYPE_AUTH) {
        if (p.id === -1) throw new Error("rcon auth failed");
        return;
      }
    }
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.subarray(12, 4 + len - 2).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      const p = { id, type, body };
      const w = this.waiters.shift();
      if (w) w(p);
      else this.queued.push(p);
    }
  }

  private read(timeoutMs: number): Promise<Packet> {
    const q = this.queued.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== h);
        reject(new Error("rcon read timeout"));
      }, timeoutMs);
      const h = (p: Packet) => {
        clearTimeout(t);
        resolve(p);
      };
      this.waiters.push(h);
    });
  }

  /** Run a command (leading "/" optional). Reconnects once if the socket died. */
  command(cmd: string, timeoutMs = 15000): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.connected) await this.connect();
      try {
        return await this.exec(cmd, timeoutMs);
      } catch (e) {
        if (String(e).includes("timeout") || !this.connected) {
          await this.connect();
          return this.exec(cmd, timeoutMs);
        }
        throw e;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  private async exec(cmd: string, timeoutMs: number): Promise<string> {
    const sock = this.sock;
    if (!sock) throw new Error("rcon not connected");
    const id = this.nextId++;
    sock.write(encode(id, TYPE_COMMAND, cmd.replace(/^\//, "")));
    // The server splits responses >4096 bytes across packets; no end marker
    // exists (unknown packet types make it drop the connection), so keep
    // reading while the last chunk was full-size.
    let out = "";
    let p = await this.read(timeoutMs);
    for (;;) {
      if (p.id === id && p.type === TYPE_RESPONSE) {
        out += p.body;
        if (Buffer.byteLength(p.body) < 4096) return out;
      }
      try {
        p = await this.read(1500);
      } catch {
        return out;
      }
    }
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }
}

export function rconFromEnv(env: Record<string, string | undefined>): Rcon {
  const pw = env.RCON_PASSWORD;
  if (!pw) throw new Error("RCON_PASSWORD missing from env");
  return new Rcon(env.RCON_HOST ?? "127.0.0.1", Number(env.RCON_PORT ?? 25576), pw);
}
