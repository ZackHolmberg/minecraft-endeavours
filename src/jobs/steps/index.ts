/** Step executor: dispatches a planner Step to its executor against the live bot. */
import type { Bot } from "mineflayer";
import type { Step } from "../../planner/types.js";
import type { ExecuteStep, StepRunContext } from "../runner.js";
import type { StepResult } from "../types.js";
import { craftStep } from "./craft.js";
import { gatherStep } from "./gather.js";
import { placeStationStep } from "./place-station.js";
import { smeltStep } from "./smelt.js";
import { withdrawStep } from "./withdraw.js";

export function createStepExecutor(bot: Bot): ExecuteStep {
  return (step: Step, ctx: StepRunContext): Promise<StepResult> => {
    const env = { bot, ctx };
    switch (step.op) {
      case "gather":
        return gatherStep(env, step);
      case "craft":
        return craftStep(env, step);
      case "smelt":
        return smeltStep(env, step);
      case "withdraw":
        return withdrawStep(env, step);
      case "place_station":
        return placeStationStep(env, step);
    }
  };
}
