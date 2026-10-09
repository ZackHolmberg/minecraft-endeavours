import type { GameMode, PlayersResponse } from "../../../shared/api.js";
import { api, errorMessage } from "./api.js";
import { toast } from "../components/ui.js";

export const MODE_LABEL: Record<GameMode, string> = { survival: "Survival", creative: "Creative", adventure: "Adventure", spectator: "Spectator" };

/** POST /api/players/gamemode; toasts the outcome. Returns the fresh player list, or null on failure. */
export async function setGameMode(name: string, mode: GameMode): Promise<PlayersResponse | null> {
  try {
    const next = await api.post<PlayersResponse>("/api/players/gamemode", { name, mode });
    toast(`${name} → ${MODE_LABEL[mode]}`);
    return next;
  } catch (e) {
    toast(`Couldn't change ${name}'s game mode: ${errorMessage(e)}`, "bad", 7000);
    return null;
  }
}
