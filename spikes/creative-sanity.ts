/**
 * Offline sanity checks for creative-mode support (no server, no bot).
 * Run: npx tsx spikes/creative-sanity.ts
 *
 * Fakes just enough of a mineflayer Bot to exercise:
 *  - makeCreativeItem → prismarine-item objects + their 1.21.9 wire form
 *  - creativeGive / getItems slot filling (hotbar first, top-up semantics,
 *    stack sizes, inventory-full reporting, survival refusal)
 *  - flight geometry (hover-spot search never overlaps the target cell,
 *    respects reach, avoids solid blocks)
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { creativeGive, getItems, makeCreativeItem } from "../src/skills/creative.js";
import { bodyClearAt, findPlaceHoverSpot } from "../src/skills/flight.js";

const require = createRequire(import.meta.url);
const mcData = require("minecraft-data")("1.21.9");
const Item = require("prismarine-item")(mcData);

type Slot = InstanceType<typeof Item> | null;

function fakeBot(mode: string, solids: Set<string> = new Set()): Bot {
  const slots: Slot[] = new Array(46).fill(null);
  const inventory = {
    slots,
    hotbarStart: 36,
    items: () => slots.slice(9, 45).filter((s): s is NonNullable<Slot> => s !== null),
    count: (id: number) => slots.slice(9, 45).reduce((n, s) => n + (s && s.type === id ? s.count : 0), 0),
  };
  const bot = {
    registry: mcData,
    game: { gameMode: mode },
    inventory,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    creative: {
      // Mirrors mineflayer's noAck path: local write, no server confirmation.
      setInventorySlot: async (slot: number, item: Slot) => {
        assert.ok(slot >= 0 && slot <= 44, `slot ${slot} out of range`);
        slots[slot] = item;
      },
    },
    blockAt: (p: Vec3) => ({
      name: solids.has(`${p.x},${p.y},${p.z}`) ? "stone" : "air",
      boundingBox: solids.has(`${p.x},${p.y},${p.z}`) ? "block" : "empty",
    }),
  };
  return bot as unknown as Bot;
}

const id = (name: string): number => mcData.itemsByName[name].id;

// 1. Item construction + wire form.
{
  const bot = fakeBot("creative");
  const it = makeCreativeItem(bot, id("cobblestone"), 64);
  assert.equal(it.name, "cobblestone");
  assert.equal(it.count, 64);
  const notch = Item.toNotch(it);
  assert.equal(notch.itemCount, 64);
  assert.equal(notch.itemId, id("cobblestone"));
  console.log("ok  item construction", JSON.stringify(notch));
}

// 2. Hotbar-first fill, stack sizes, top-up semantics.
{
  const bot = fakeBot("creative");
  const r = await creativeGive(bot, id("oak_planks"), 150);
  assert.equal(r.added, 150);
  const s = bot.inventory.slots;
  assert.equal(s[36]?.count, 64);
  assert.equal(s[37]?.count, 64);
  assert.equal(s[38]?.count, 22);
  // Top-up: asking for 150 again adds nothing; 160 grows the partial stack.
  assert.equal((await creativeGive(bot, id("oak_planks"), 150)).added, 0);
  assert.equal((await creativeGive(bot, id("oak_planks"), 160)).added, 10);
  assert.equal(s[38]?.count, 32);
  // Unstackables get one slot each.
  await creativeGive(bot, id("diamond_sword"), 2);
  assert.equal(s[39]?.name, "diamond_sword");
  assert.equal(s[40]?.name, "diamond_sword");
  // 16-stackers.
  await creativeGive(bot, id("ender_pearl"), 20);
  assert.equal(s[41]?.count, 16);
  assert.equal(s[42]?.count, 4);
  console.log("ok  slot filling");
}

// 3. getItems: survival refusal, typo, default stack, inventory full.
{
  const surv = fakeBot("survival");
  const refused = await getItems(surv, { items: [{ name: "stone" }] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /only works in creative mode — you're in survival/);
  assert.equal(surv.inventory.items().length, 0, "survival must not touch slots");

  const bot = fakeBot("creative");
  const typo = await getItems(bot, { items: [{ name: "stone brick" }] });
  assert.equal(typo.ok, false);
  assert.match(typo.message, /did you mean/);

  const ok = await getItems(bot, { items: [{ name: "Stone Bricks" }, { name: "oak door", count: 1 }] });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(bot.inventory.count(id("stone_bricks"), null), 64);
  assert.equal(bot.inventory.count(id("oak_door"), null), 1);

  const full = await getItems(bot, { items: [{ name: "dirt", count: 64 * 40 }] });
  assert.equal(full.ok, false);
  assert.match(full.message, /inventory full/);
  assert.equal(bot.inventory.items().length, 36);
  console.log("ok  getItems", "|", ok.message, "|", full.message);
}

// 4. Flight geometry.
{
  // Wall at x=5, z=0..4 up to y=69; ground at y=63 everywhere nearby.
  const solids = new Set<string>();
  for (let x = -8; x <= 12; x++) for (let z = -8; z <= 12; z++) solids.add(`${x},63,${z}`);
  for (let y = 64; y <= 69; y++) for (let z = 0; z <= 4; z++) solids.add(`5,${y},${z}`);
  const bot = fakeBot("creative", solids);
  assert.equal(bodyClearAt(bot, new Vec3(0.5, 64, 0.5)), true);
  assert.equal(bodyClearAt(bot, new Vec3(5.5, 64, 0.5)), false);
  assert.equal(bodyClearAt(bot, new Vec3(4.75, 64, 0.5)), false, "hitbox edge clips the wall");

  // Next course on top of the wall: target (5,70,2), placed against (5,69,2).
  const target = new Vec3(5, 70, 2);
  const ref = new Vec3(5, 69, 2);
  const spot = findPlaceHoverSpot(bot, target, ref);
  assert.ok(spot, "expected a hover spot");
  assert.ok(bodyClearAt(bot, spot!));
  const eye = spot!.offset(0, 1.62, 0);
  assert.ok(eye.distanceTo(ref.offset(0.5, 0.5, 0.5)) <= 4.5);
  const overlaps =
    spot!.x + 0.3 > target.x && spot!.x - 0.3 < target.x + 1 &&
    spot!.z + 0.3 > target.z && spot!.z - 0.3 < target.z + 1 &&
    spot!.y + 1.8 > target.y && spot!.y < target.y + 1;
  assert.equal(overlaps, false, "hover spot must not overlap the target cell");
  console.log("ok  hover spot", spot!.toString());
}

console.log("all creative sanity checks passed");
