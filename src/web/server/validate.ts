/** Input validation for everything that reaches RCON or the filesystem. */

export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const BOT_NAME_RE = PLAYER_NAME_RE;
export const CONSOLE_MAX = 256;
export const MESSAGE_MAX = 200;

// C0, DEL, C1, and Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export class ValidationError extends Error {}

export function validateConsoleCommand(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("command must be a string");
  if (CONTROL_RE.test(raw)) throw new ValidationError("command must not contain newlines or control characters");
  let cmd = raw.trim();
  if (cmd.startsWith("/")) cmd = cmd.slice(1).trimStart();
  if (cmd.length === 0) throw new ValidationError("command is empty");
  if (cmd.length > CONSOLE_MAX) throw new ValidationError(`command exceeds ${CONSOLE_MAX} characters`);
  // rcon-cli parses its own flags; a leading "-" could be read as one.
  if (cmd.startsWith("-")) throw new ValidationError("command must not start with '-'");
  return cmd;
}

export function validatePlayerName(raw: unknown): string {
  if (typeof raw !== "string" || !PLAYER_NAME_RE.test(raw)) {
    throw new ValidationError("invalid player name (3–16 chars, letters, digits, underscore)");
  }
  return raw;
}

/** Free text that ends up inside an RCON command (say / kick reason). */
export function validateMessage(raw: unknown, field: string, optional = false): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (optional) return null;
    throw new ValidationError(`${field} is required`);
  }
  if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`);
  if (CONTROL_RE.test(raw)) throw new ValidationError(`${field} must not contain control characters`);
  const t = raw.trim();
  if (!t) {
    if (optional) return null;
    throw new ValidationError(`${field} is required`);
  }
  if (t.length > MESSAGE_MAX) throw new ValidationError(`${field} exceeds ${MESSAGE_MAX} characters`);
  if (t.startsWith("-")) throw new ValidationError(`${field} must not start with '-'`);
  return t;
}

const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;
export function validateGameMode(raw: unknown): (typeof GAME_MODES)[number] {
  if (typeof raw !== "string" || !(GAME_MODES as readonly string[]).includes(raw)) {
    throw new ValidationError("mode must be one of survival, creative, adventure, spectator");
  }
  return raw as (typeof GAME_MODES)[number];
}

export function validateBool(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return raw;
}

export function intParam(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw === "") return def;
  if (!/^\d{1,9}$/.test(raw)) throw new ValidationError("invalid integer parameter");
  return Math.min(max, Math.max(min, Number(raw)));
}
