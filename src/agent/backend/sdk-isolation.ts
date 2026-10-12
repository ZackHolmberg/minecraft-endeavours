/**
 * SDK session isolation for every bot `query()` (promotion review H1).
 *
 * The bot's sessions must see nothing of the operator's Claude Code setup. Verified against the installed SDK
 * (0.3.293) with a probe that asks the model what it can see:
 *  - `settingSources: []` — no ~/.claude/settings.json, project or local settings: drops the operator's user plugins
 *    and skills (41 skills / 4 plugins before, 17 built-in skills / 3 built-in plugins after).
 *  - It does NOT stop AUTO-MEMORY: the operator's MEMORY.md index (hostnames, deployment choices) was still in the
 *    model's context. `settings.autoMemoryEnabled: false` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` close that.
 *  - `skills: []` (omitted = CLI defaults, not "off"), `CLAUDE_CODE_DISABLE_CLAUDE_MDS` (CLAUDE.md files) and
 *    `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` (built-in skills; the init shows 3 left) are belt and braces: the session
 *    also runs with `tools: []`, so no skill / file tool exists to use them.
 * The `sdk init` log line (init-summary.ts) shows what a session actually loaded.
 */
export interface SdkIsolation {
  settingSources: [];
  skills: [];
  settings: { autoMemoryEnabled: false };
  env: Record<string, string | undefined>;
}

export function sdkIsolation(baseEnv: NodeJS.ProcessEnv = process.env): SdkIsolation {
  return {
    settingSources: [],
    skills: [],
    settings: { autoMemoryEnabled: false },
    env: {
      ...baseEnv,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    },
  };
}
