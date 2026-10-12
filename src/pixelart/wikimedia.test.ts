import { describe, expect, it } from "vitest";
import { findImage, isFreeLicense, parseSearch, pickCandidate, searchUrl, stripHtml, WIKI_HOSTS } from "./wikimedia.js";
import type { HopResponse, Resolver, Transport } from "./safe-fetch.js";

const page = (index: number, title: string, mime: string, license: string, extra: Record<string, unknown> = {}, nonFree?: string) => ({
  ns: 6,
  title,
  index,
  imageinfo: [
    {
      mime,
      width: 437,
      height: 299,
      url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title.slice(5))}`,
      thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title.slice(5))}/500px-x.png`,
      descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      extmetadata: {
        LicenseShortName: { value: license },
        Artist: { value: '<a href="//x">Jane <b>Doe</b></a>' },
        Credit: { value: "Own work" },
        Restrictions: { value: "trademarked" },
        ...(nonFree ? { NonFree: { value: nonFree } } : {}),
      },
      ...extra,
    },
  ],
});

const FIXTURE = {
  query: {
    pages: [
      page(3, "File:Cupcakes.jpg", "image/jpeg", "CC BY 2.0"),
      page(1, "File:Montreal Canadiens.svg", "image/svg+xml", "Public domain"),
      page(2, "File:Doc.pdf", "application/pdf", "Public domain"),
      page(4, "File:Fair.png", "image/png", "Fair use", {}, "true"),
    ],
  },
};

describe("parseSearch / pickCandidate", () => {
  it("orders by search rank, drops non-images, strips HTML from attribution", () => {
    const c = parseSearch(FIXTURE);
    expect(c.map((x) => x.title)).toEqual(["Montreal Canadiens.svg", "Cupcakes.jpg", "Fair.png"]);
    expect(c[0]).toMatchObject({ license: "Public domain", free: true, restrictions: "trademarked", attribution: "Jane Doe / Own work" });
    expect(c[0]!.fetchUrl).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(c[2]!.free).toBe(false);
  });
  it("prefers free licences; non-free only as a last resort", () => {
    const c = parseSearch({ query: { pages: [page(1, "File:Fair.png", "image/png", "Fair use", {}, "true"), page(2, "File:Free.png", "image/png", "CC0")] } });
    expect(pickCandidate(c, true)?.title).toBe("Free.png");
    expect(pickCandidate(c.slice(0, 1), true)).toBeNull();
    expect(pickCandidate(c.slice(0, 1), false)?.title).toBe("Fair.png");
  });
  it("ignores malformed responses and SVGs without a rendered thumbnail", () => {
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({})).toEqual([]);
    expect(parseSearch({ query: { pages: "x" } })).toEqual([]);
    const svg = page(1, "File:A.svg", "image/svg+xml", "CC0");
    delete (svg.imageinfo[0] as Record<string, unknown>)["thumburl"];
    expect(parseSearch({ query: { pages: [svg] } })).toEqual([]);
  });
  it("licence classification", () => {
    for (const l of ["Public domain", "CC0", "CC BY 4.0", "CC BY-SA 3.0", "GFDL", "PD-textlogo"]) expect(isFreeLicense(l, ""), l).toBe(true);
    for (const l of ["", "Fair use", "All rights reserved", "Non-free logo"]) expect(isFreeLicense(l, ""), l).toBe(false);
    expect(isFreeLicense("CC0", "true")).toBe(false);
  });
  it("stripHtml", () => {
    expect(stripHtml('<a href="x">A &amp; B</a>\n<script>')).toBe("A & B");
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml("x".repeat(500))).toHaveLength(200);
  });
});

describe("searchUrl / findImage", () => {
  it("builds an https API URL on an allow-listed host", () => {
    const u = new URL(searchUrl("commons.wikimedia.org", "Montreal Canadiens logo"));
    expect(u.protocol).toBe("https:");
    expect(WIKI_HOSTS.has(u.hostname)).toBe(true);
    expect(u.searchParams.get("gsrsearch")).toBe("Montreal Canadiens logo");
    expect(u.searchParams.get("iiurlwidth")).toBe("500");
  });
  const json = (o: unknown): HopResponse => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(o)); })(), destroy: () => {} });
  const deps = (pages: Record<string, unknown>) => {
    const hosts: string[] = [];
    const resolve: Resolver = async () => ["185.15.58.224"];
    const transport: Transport = async ({ url }) => {
      hosts.push(url.hostname);
      return json(pages[url.hostname] ?? { query: { pages: [] } });
    };
    return { hosts, deps: { resolve, transport } };
  };
  it("returns the best Commons hit", async () => {
    const d = deps({ "commons.wikimedia.org": FIXTURE });
    const r = await findImage("Montreal Canadiens logo", d.deps);
    expect(r).toMatchObject({ ok: true, image: { title: "Montreal Canadiens.svg" } });
    expect(d.hosts).toEqual(["commons.wikimedia.org"]);
  });
  it("falls back to English Wikipedia (non-free allowed) when Commons has nothing free", async () => {
    const d = deps({ "en.wikipedia.org": { query: { pages: [page(1, "File:Logo.png", "image/png", "", {}, "true")] } } });
    const r = await findImage("Some Team logo", d.deps);
    expect(r).toMatchObject({ ok: true, image: { title: "Logo.png", free: false } });
    expect(d.hosts).toEqual(["commons.wikimedia.org", "en.wikipedia.org"]);
  });
  it("reports nothing found, and rejects empty names without touching the network", async () => {
    const d = deps({});
    expect(await findImage("zzzz qqqq", d.deps)).toMatchObject({ ok: false });
    const e = deps({});
    expect(await findImage("  ", e.deps)).toMatchObject({ ok: false });
    expect(e.hosts).toEqual([]);
  });
  it("a search result pointing the thumbnail at a foreign host is not fetched here (allowlist is applied by the caller)", () => {
    const c = parseSearch({ query: { pages: [page(1, "File:A.png", "image/png", "CC0", { thumburl: "https://evil.example.com/a.png" })] } });
    expect(new URL(c[0]!.fetchUrl).hostname).toBe("evil.example.com");
    expect(WIKI_HOSTS.has("evil.example.com")).toBe(false);
  });
});
