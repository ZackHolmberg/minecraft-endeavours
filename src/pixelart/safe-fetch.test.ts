import { describe, expect, it } from "vitest";
import { pinAddress, safeGet, sniffImage, type HopResponse, type Resolver, type Transport } from "./safe-fetch.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function body(chunks: Buffer[], opts: { delayMs?: number } = {}): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      yield c;
    }
  })();
}
const ok = (chunks: Buffer[], headers: HopResponse["headers"] = {}): HopResponse => ({ status: 200, headers, body: body(chunks), destroy: () => {} });
const redirect = (to: string, status = 302): HopResponse => ({ status, headers: { location: to }, body: body([]), destroy: () => {} });

/** Scripted world: host -> addresses, and per-URL responses. Records every connection (url + the address it was pinned to). */
function world(dns: Record<string, string[] | (() => string[])>, pages: Record<string, () => HopResponse>) {
  const lookups: string[] = [];
  const conns: Array<{ url: string; address: string }> = [];
  const resolve: Resolver = async (h) => {
    lookups.push(h);
    const v = dns[h];
    if (!v) throw new Error("ENOTFOUND");
    return typeof v === "function" ? v() : v;
  };
  const transport: Transport = async ({ url, address }) => {
    conns.push({ url: url.toString(), address });
    const page = pages[url.toString()];
    if (!page) return { status: 404, headers: {}, body: body([]), destroy: () => {} };
    return page();
  };
  return { deps: { resolve, transport }, lookups, conns };
}

describe("safeGet", () => {
  it("fetches and connects to the validated address", async () => {
    const w = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/a.png": () => ok([PNG], { "content-type": "image/png" }) });
    const r = await safeGet("https://img.example.com/a.png", {}, w.deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.equals(PNG)).toBe(true);
    expect(w.conns).toEqual([{ url: "https://img.example.com/a.png", address: "93.184.216.34" }]);
  });

  it("refuses a host that resolves to a private address (any record)", async () => {
    for (const addrs of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["::ffff:192.168.0.1"], ["93.184.216.34", "10.0.0.5"], ["fd00::1"], ["100.64.1.1"]]) {
      const w = world({ "evil.example.com": addrs }, { "https://evil.example.com/a.png": () => ok([PNG]) });
      const r = await safeGet("https://evil.example.com/a.png", {}, w.deps);
      expect(r.ok, addrs.join()).toBe(false);
      expect(w.conns).toHaveLength(0);
    }
  });

  it("DNS rebinding: resolves once per hop and connects to THAT address, never re-resolving", async () => {
    let n = 0;
    const w = world({ "rebind.example.com": () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]) }, { "https://rebind.example.com/a.png": () => ok([PNG]) });
    const r = await safeGet("https://rebind.example.com/a.png", {}, w.deps);
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual(["rebind.example.com"]);
    expect(w.conns[0]!.address).toBe("93.184.216.34");
  });

  it("a rebinding host is refused when its FIRST answer is private", async () => {
    let n = 0;
    const w = world({ "rebind.example.com": () => (n++ === 0 ? ["127.0.0.1"] : ["93.184.216.34"]) }, { "https://rebind.example.com/a.png": () => ok([PNG]) });
    expect((await safeGet("https://rebind.example.com/a.png", {}, w.deps)).ok).toBe(false);
    expect(w.conns).toHaveLength(0);
  });

  it("follows up to 3 redirects, re-validating each hop", async () => {
    const w = world(
      { "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.35"], "c.example.com": ["93.184.216.36"], "d.example.com": ["93.184.216.37"] },
      {
        "https://a.example.com/1": () => redirect("https://b.example.com/2"),
        "https://b.example.com/2": () => redirect("/3", 301),
        "https://b.example.com/3": () => redirect("https://c.example.com/4", 307),
        "https://c.example.com/4": () => ok([PNG]),
      },
    );
    const r = await safeGet("https://a.example.com/1", {}, w.deps);
    expect(r.ok).toBe(true);
    expect(w.conns.map((c) => c.address)).toEqual(["93.184.216.34", "93.184.216.35", "93.184.216.35", "93.184.216.36"]);
  });

  it("refuses a 4th redirect and redirect loops", async () => {
    const w = world(
      { "a.example.com": ["93.184.216.34"] },
      { "https://a.example.com/1": () => redirect("/2"), "https://a.example.com/2": () => redirect("/3"), "https://a.example.com/3": () => redirect("/4"), "https://a.example.com/4": () => redirect("/5"), "https://a.example.com/5": () => ok([PNG]) },
    );
    const r = await safeGet("https://a.example.com/1", {}, w.deps);
    expect(r).toMatchObject({ ok: false });
    expect(w.conns).toHaveLength(4);
    const loop = world({ "a.example.com": ["93.184.216.34"] }, { "https://a.example.com/x": () => redirect("/x") });
    expect((await safeGet("https://a.example.com/x", {}, loop.deps)).ok).toBe(false);
  });

  it("refuses a redirect to a private address, an IP literal, http, localhost, a metadata URL", async () => {
    for (const target of ["https://internal.example.com/a.png", "https://127.0.0.1/a.png", "https://169.254.169.254/latest/meta-data/", "http://img.example.com/a.png", "https://localhost/a.png", "https://[::1]/", "https://2130706433/", "https://img.example.com:8080/a.png", "file:///etc/passwd", "https://user:pw@img.example.com/"]) {
      const w = world({ "img.example.com": ["93.184.216.34"], "internal.example.com": ["10.1.2.3"] }, { "https://img.example.com/r": () => redirect(target) });
      const r = await safeGet("https://img.example.com/r", {}, w.deps);
      expect(r.ok, target).toBe(false);
      expect(w.conns.map((c) => c.address), target).toEqual(["93.184.216.34"]);
    }
  });

  it("caps the body while streaming (lying or missing Content-Length) and by declared length", async () => {
    const big = Buffer.alloc(64 * 1024, 1);
    const stream = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/big": () => ok(Array.from({ length: 100 }, () => big), { "content-length": "10" }) });
    const r = await safeGet("https://img.example.com/big", { maxBytes: 1024 * 1024 }, stream.deps);
    expect(r).toMatchObject({ ok: false });
    const declared = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/big": () => ok([PNG], { "content-length": String(50 * 1024 * 1024) }) });
    const r2 = await safeGet("https://img.example.com/big", {}, declared.deps);
    expect(r2).toMatchObject({ ok: false });
    // exactly at the cap is fine
    const exact = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/e": () => ok([Buffer.alloc(1000)]) });
    expect((await safeGet("https://img.example.com/e", { maxBytes: 1000 }, exact.deps)).ok).toBe(true);
    const over = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/e": () => ok([Buffer.alloc(1001)]) });
    expect((await safeGet("https://img.example.com/e", { maxBytes: 1000 }, over.deps)).ok).toBe(false);
  });

  it("times out a slow body (slowloris)", async () => {
    const w = world({ "img.example.com": ["93.184.216.34"] }, { "https://img.example.com/slow": () => ({ status: 200, headers: {}, body: body([PNG, PNG, PNG], { delayMs: 200 }), destroy: () => {} }) });
    const t0 = Date.now();
    const r = await safeGet("https://img.example.com/slow", { timeoutMs: 100 }, { ...w.deps, transport: async (req) => {
      const res = await w.deps.transport(req);
      // like a socket: the iterator ends with an error when the deadline aborts the request
      return { ...res, body: (async function* () { for await (const c of res.body) { if (req.signal.aborted) throw new Error("aborted"); yield c; } if (req.signal.aborted) throw new Error("aborted"); })() };
    } });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("maps non-200 and unresolvable hosts to refusals", async () => {
    const w = world({ "img.example.com": ["93.184.216.34"] }, {});
    expect(await safeGet("https://img.example.com/missing", {}, w.deps)).toEqual({ ok: false, reason: "HTTP 404" });
    expect((await safeGet("https://nowhere.example.com/x", {}, w.deps)).ok).toBe(false);
  });

  it("enforces the per-hop host allowlist", async () => {
    const w = world({ "commons.wikimedia.org": ["185.15.58.224"], "evil.example.com": ["93.184.216.34"] }, { "https://commons.wikimedia.org/r": () => redirect("https://evil.example.com/x.png") });
    const r = await safeGet("https://commons.wikimedia.org/r", { hostAllowed: (h) => h.endsWith("wikimedia.org") }, w.deps);
    expect(r.ok).toBe(false);
    expect(w.conns).toHaveLength(1);
  });

  it("never sends credentials: the headers handed to the transport are fixed", async () => {
    let seen: Record<string, string> = {};
    const r = await safeGet("https://img.example.com/a.png", {}, {
      resolve: async () => ["93.184.216.34"],
      transport: async ({ headers }) => {
        seen = headers;
        return ok([PNG]);
      },
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(["Accept", "Accept-Encoding", "Connection", "User-Agent"]);
    expect(seen["User-Agent"]).toContain("minecraft-endeavours-bot/2");
    expect(seen["User-Agent"]).not.toContain("@");
    expect(seen["Accept-Encoding"]).toBe("identity");
  });
});

describe("pinAddress", () => {
  it("rejects results that aren't IPs", async () => {
    expect((await pinAddress("x.example.com", async () => ["not-an-ip"])).ok).toBe(false);
    expect((await pinAddress("x.example.com", async () => [])).ok).toBe(false);
  });
});

describe("sniffImage", () => {
  it("recognises PNG / JPEG / GIF / WebP by magic bytes only", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(sniffImage(Buffer.from("GIF89a....", "latin1"))).toBe("gif");
    expect(sniffImage(Buffer.from("GIF87a....", "latin1"))).toBe("gif");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("webp");
  });
  it("rejects SVG, HTML, TIFF, BMP, PDF, ICO, empty and truncated files", () => {
    for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "<?xml version='1.0'?><svg/>", "<!doctype html><html>", "II*\0....", "BM......", "%PDF-1.4", "\x00\x00\x01\x00", "", "\x89PNG", "RIFF....WAVE"]) {
      expect(sniffImage(Buffer.from(s, "latin1")), s).toBeNull();
    }
  });
});
