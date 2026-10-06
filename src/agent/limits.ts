/**
 * Agent limits shared by the backend (enforcement) and the report CLI
 * (flagging). Dependency-free so the standalone report can import it.
 *
 * Max assistant turns the SDK will take per player message before terminating
 * with `error_max_turns`. Bumped from the spike-era 8 once we saw real builds
 * (gather → craft → place loops) exceed it, then trimmed from 100 to 50 for
 * Haiku: a small house is ~25–35 steps with batch tools and the preloaded
 * world context, and 100 just let a confused model loop for minutes. On hit,
 * a follow-up message asks the model to report status to the player.
 */
export const MAX_TURNS_PER_EVENT = 50;
