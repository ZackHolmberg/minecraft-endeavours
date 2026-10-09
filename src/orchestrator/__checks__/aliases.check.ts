/**
 * Offline check: configured aliases flow config -> chat router.
 * Run: npx tsx src/orchestrator/__checks__/aliases.check.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import { isAddressed, isStopCommand, nameAliases, registerOnlinePlayers, resetChatRouter } from "../chat-router.js";

process.env.MC_VERSION = "1.21.9";
const dir = mkdtempSync(join(tmpdir(), "aliases-"));
const write = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const chat = (message: string) => ({ channel: "chat" as const, sender: "Zack", message });

// Repo config: Steve_v2 answers to "steve".
const cfg = loadConfig("config/bots.yml");
assert.deepEqual(cfg.bots[0]!.aliases, ["steve"]);
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("steve, chop some logs"))?.reason, "name-mention");
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("Hey STEVE!"))?.reason, "name-mention");
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("steven is here")), null, "word boundary");
assert.equal(isStopCommand("Steve_v2", "steve stop"), true);
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("Steve_v2 hi"))?.reason, "name-mention");

// Two bots: naming the other (by alias) is "not for me".
resetChatRouter();
const two = loadConfig(write("two.yml", "bots:\n  - username: Steve_v2\n    aliases: [steve]\n  - username: Alex_bot\n    aliases: [lex, al]\n"));
const all = two.bots.map((b) => b.username);
assert.equal(isAddressed("Steve_v2", all, chat("lex, come here")), null, "alias of the other bot");
assert.equal(isAddressed("Alex_bot", all, chat("lex, come here"))?.reason, "name-mention");
assert.equal(isAddressed("Alex_bot", all, chat("alex hi"))?.reason, "name-mention", "derived alias still works");
assert.equal(isAddressed("Steve_v2", all, chat("steve hi"))?.reason, "name-mention");
assert.equal(isAddressed("Alex_bot", all, chat("steve hi")), null);

// Validation.
for (const [label, yml, re] of [
  ["too short", "bots:\n  - username: Steve_v2\n    aliases: [s]\n", /2-16/],
  ["bad chars", "bots:\n  - username: Steve_v2\n    aliases: ['st eve']\n", /2-16/],
  ["too long", "bots:\n  - username: Steve_v2\n    aliases: [abcdefghijklmnopq]\n", /2-16/],
  ["not a list", "bots:\n  - username: Steve_v2\n    aliases: steve\n", /list/],
  ["collision", "bots:\n  - username: Steve_v2\n    aliases: [alex_bot]\n  - username: Alex_bot\n", /collides/],
  ["derived vs alias", "bots:\n  - username: Steve_v2\n    aliases: [steve]\n  - username: Steve_AI\n", /suffix-stripped/],
  ["derived vs username", "bots:\n  - username: Steve_AI\n  - username: Steve\n", /suffix-stripped/],
] as const) {
  assert.throws(() => loadConfig(write(`${label}.yml`, yml)), re, label);
}

// A human player literally named "Steve" online: the alias is dropped (so
// their chat/"steve stop" does not address the bot); the real username stays.
resetChatRouter();
loadConfig("config/bots.yml");
assert.ok(nameAliases("Steve_v2").includes("steve"));
let online = ["Steve_v2", "Zack"];
registerOnlinePlayers("Steve_v2", () => online);
assert.ok(nameAliases("Steve_v2").includes("steve"), "no human called Steve: alias kept");
online = ["Steve_v2", "STEVE"];
assert.deepEqual(nameAliases("Steve_v2"), ["Steve_v2"], "human Steve online: alias dropped (case-insensitive)");
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("steve, chop some logs")), null);
assert.equal(isAddressed("Steve_v2", ["Steve_v2"], chat("Steve_v2 chop some logs"))?.reason, "name-mention");
assert.equal(isStopCommand("Steve_v2", "steve stop"), false);
online = ["Steve_v2", "Zack"];
assert.ok(nameAliases("Steve_v2").includes("steve"), "alias returns when the human leaves");
resetChatRouter();
console.log("aliases: all assertions passed");
