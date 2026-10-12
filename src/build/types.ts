/**
 * Blueprint builder contract (v2 slice 3). Design: v2/reports/slice3-build.md.
 *
 * Everything under src/build/ is PURE (no mineflayer, no I/O): blueprint
 * geometry, site choice over an abstract block grid, support/scaffold ordering
 * and material math. The bot-bound executor lives in src/jobs/steps/build.ts.
 *
 * Coordinates: blueprints use RELATIVE cells. `x`/`z` are 0..size-1 from the
 * footprint's min corner; `y = 0` is the standing level (the first cell above
 * the ground), `y = -1` is the ground surface itself.
 */

export type Facing = "north" | "south" | "east" | "west";
export type BlueprintKind = "house" | "portal" | "farm" | "shelter";

export interface Cell {
  x: number;
  y: number;
  z: number;
}

/** What the executor does at a placement. Default (undefined) = place the block. */
export type PlacementAction =
  | "place" // place `block` from inventory
  | "till" // hoe the ground block here into farmland (`block` = farmland)
  | "plant" // right-click farmland below with seeds (`block` = the crop)
  | "water" // replace the ground block with a water source via a bucket
  | "ignite"; // flint_and_steel inside a frame; `block` = nether_portal (the expected result)

export interface BlockPlacement extends Cell {
  /** Block (minecraft-data name) expected at the cell when done. */
  block: string;
  /** Block state, e.g. door `{ half: "lower", facing: "south" }`. Nominal: the server derives the real one. */
  state?: Record<string, string>;
  action?: PlacementAction;
  /** Skipped when the bot has none of the material (glass windows are left open). */
  optional?: boolean;
  /** Appears by itself when another placement is made (a door's upper half). Counted, never placed. */
  derived?: boolean;
  role?: "wall" | "roof" | "floor" | "door" | "window" | "frame" | "foundation" | "farmland" | "crop" | "water" | "fire";
}

export interface Blueprint {
  kind: BlueprintKind;
  facing: Facing;
  /** Bounding box of the footprint (x,z after rotation) and total height. */
  size: Cell;
  placements: BlockPlacement[];
  /** Cells that must stay free of blocks (portal interior, door gap): never used as scaffolding. */
  clear: Cell[];
  /** Extra ring around the footprint the bot needs to be able to work in (site check). */
  margin: number;
  /** Normalised parameters (what was actually built), for summaries. */
  params: Record<string, unknown>;
  summary: string;
}

export interface HouseParams {
  width: number;
  depth: number;
  height: number;
  wall: string;
  roof: string;
  floor?: string;
  door: boolean;
  windows: number;
}

export interface FarmParams {
  size: number;
  /** "center": a water source is placed in the middle; "external": existing water within 4 hydrates the plot. */
  water: "center" | "external";
}

export function dirVec(f: Facing): { x: number; z: number } {
  switch (f) {
    case "north":
      return { x: 0, z: -1 };
    case "south":
      return { x: 0, z: 1 };
    case "east":
      return { x: 1, z: 0 };
    case "west":
      return { x: -1, z: 0 };
  }
}

export const cellKey = (c: Cell): string => `${c.x},${c.y},${c.z}`;
