/**
 * Tracks the name of the skill currently executing for a bot. Set by
 * `runSkill` before dispatching the skill function, cleared in a `finally`
 * so it's always reset even on exception. Surfaced by the snapshot helper
 * (phase 2) so the dashboard can show "DOING mineBlock(...)" live.
 *
 * Lives in state/ rather than on the agent because runSkill already touches
 * state and adding an agent import would create a cycle through skill-tools.
 */

export class CurrentToolTracker {
  private name: string | null = null;
  private since: number | null = null;

  begin(name: string): void {
    this.name = name;
    this.since = Date.now();
  }

  end(): void {
    this.name = null;
    this.since = null;
  }

  current(): { name: string; since: number } | null {
    if (this.name === null || this.since === null) return null;
    return { name: this.name, since: this.since };
  }
}
