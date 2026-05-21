/**
 * Shared types for the skill layer.
 *
 * Every skill is `(bot, params) => Promise<SkillResult>` and returns the same
 * shape regardless of success. Failure messages are written for Claude's eyes
 * and must be specific enough to drive adaptation (e.g. "no oak_log within 64
 * blocks", not "failed").
 */

export interface SkillResult {
  ok: boolean;
  message: string;
  state?: object;
}

export interface Coords {
  x: number;
  y: number;
  z: number;
}

export type GoToTarget =
  | { kind: "coords"; coords: Coords }
  | { kind: "entity"; entity: string }
  | { kind: "block"; block: string };
