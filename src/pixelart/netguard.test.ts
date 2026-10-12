import { describe, expect, it } from "vitest";
import { ipBlockReason, parseIPv6, validateUrl } from "./netguard.js";

const bad = (u: string): string => {
  const r = validateUrl(u);
  expect(r.ok, `${u} should be refused`).toBe(false);
  return r.ok ? "" : r.reason;
};

describe("validateUrl", () => {
  it("accepts a plain https URL", () => {
    expect(validateUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png").ok).toBe(true);
    expect(validateUrl("https://i.imgur.com:443/abc.png").ok).toBe(true);
    expect(validateUrl("  https://example.com/a b.png ").ok).toBe(true);
  });
  it("refuses other schemes", () => {
    for (const u of ["http://example.com/a.png", "ftp://example.com/a.png", "file:///etc/passwd", "gopher://example.com/", "data:image/png;base64,AAAA", "javascript:alert(1)", "//example.com/a.png", "example.com/a.png"]) bad(u);
  });
  it("refuses credentials and odd ports", () => {
    bad("https://user:pw@example.com/a.png");
    bad("https://user@example.com/a.png");
    bad("https://example.com:8443/a.png");
    bad("https://example.com:80/a.png");
  });
  it("refuses IP literals in every spelling (the URL parser canonicalises them first)", () => {
    for (const u of [
      "https://127.0.0.1/",
      "https://8.8.8.8/", // even public IP literals: names only
      "https://2130706433/", // decimal 127.0.0.1
      "https://0x7f000001/", // hex
      "https://0x7f.0.0.1/",
      "https://0177.0.0.1/", // octal
      "https://017700000001/",
      "https://127.1/", // short form
      "https://0/", // 0.0.0.0
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[fe80::1]/",
      "https://[2001:db8::1]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00:ec2::254]/",
      "https://10.0.0.1/",
      "https://192.168.1.1:443/",
    ]) {
      bad(u);
    }
  });
  it("refuses local / single-label names", () => {
    for (const u of ["https://localhost/a.png", "https://LOCALHOST./a.png", "https://intranet/a.png", "https://printer.local/a.png", "https://foo.internal/a.png", "https://foo.localhost/a.png", "https://router.lan/a.png"]) bad(u);
  });
  it("refuses garbage and absurd lengths", () => {
    bad("");
    bad("not a url");
    bad("https://" + "a".repeat(3000) + ".com/");
    bad("https://exa mple.com/");
  });
});

describe("ipBlockReason: IPv4", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255", "169.254.169.254", "169.254.0.1",
    "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ])("blocks %s", (ip) => expect(ipBlockReason(ip)).not.toBeNull());
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.0.1", "192.167.0.1", "198.17.0.1", "223.255.255.255", "185.199.108.153"])("allows public %s", (ip) => expect(ipBlockReason(ip)).toBeNull());
  it("treats malformed input as blocked", () => {
    for (const ip of ["", "1.2.3", "256.1.1.1", "1.2.3.4.5", "01.2.3.4x", "localhost", "0x7f.0.0.1", "2130706433", "1.2.3.-4"]) expect(ipBlockReason(ip), ip).not.toBeNull();
  });
});

describe("ipBlockReason: IPv6", () => {
  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", // mapped (even a public one is refused)
    "0:0:0:0:0:ffff:192.168.1.1", "0000:0000:0000:0000:0000:ffff:c0a8:0101",
    "::127.0.0.1", "::10.0.0.1", // IPv4-compatible
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::8.8.8.8", // NAT64
    "fe80::1", "fe80::1%eth0", "febf::1", "fc00::1", "fd12:3456:789a::1", "fd00:ec2::254", // link-local, ULA
    "fec0::1", // site-local
    "ff02::1", "ff00::", // multicast
    "2001:db8::1", "2001:0db8:85a3::8a2e:370:7334", // documentation
    "2002:7f00:1::", "2002:a00:1::1", "2002:808:808::1", // 6to4
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2001:10::1", // ORCHID
    "100::1", "3fff::1",
    "1::1", "4000::1", // outside 2000::/3
  ])("blocks %s", (ip) => expect(ipBlockReason(ip), ip).not.toBeNull());
  it.each(["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2620:0:860:ed1a::1", "2001:4860:4860::8888", "2400:cb00::1"])("allows global %s", (ip) => expect(ipBlockReason(ip), ip).toBeNull());
  it("parses every notation to 8 groups", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("64:ff9b::1.2.3.4")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
    expect(parseIPv6("[fe80::1]")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("12345::1")).toBeNull();
    expect(parseIPv6("1.2.3.4")).toBeNull();
  });
});
