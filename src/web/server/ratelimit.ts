/**
 * In-memory rate limiting.
 *
 *  - `SlidingLimiter`: N events per window per key (API, console, actions,
 *    unauthenticated traffic, WS messages).
 *  - `LoginGuard`: per-IP exponential lockout plus a global *slowdown*
 *    (covers distributed guessing). Everything is in memory; a panel restart
 *    resets it, which only happens on crash/reboot under launchd.
 */

const MAX_KEYS = 50_000;

export class SlidingLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns false if the key is over the limit. */
  take(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      if (this.hits.size > MAX_KEYS) {
        this.sweep(now);
        // Still over: many distinct live sources (distributed flood). Drop the
        // oldest-inserted keys so memory stays bounded; worst case a flooding
        // source gets a fresh budget, which the login guard's global ceiling covers.
        for (const k of this.hits.keys()) {
          if (this.hits.size <= MAX_KEYS * 0.9) break;
          this.hits.delete(k);
        }
      }
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
    if (arr.length >= this.max) return false;
    arr.push(now);
    return true;
  }

  sweep(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [k, arr] of this.hits) if (arr.length === 0 || arr[arr.length - 1]! <= cutoff) this.hits.delete(k);
  }
}

interface IpState {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

export const LOGIN_POLICY = {
  /** Failures from one IP before lockout starts. */
  perIpFree: 5,
  /** First lockout; doubles with every further failure. */
  baseLockMs: 60_000,
  maxLockMs: 24 * 60 * 60_000,
  /** An IP's failure count resets after this long without failures. */
  ipForgetMs: 24 * 60 * 60_000,
  /**
   * Global slowdown: while this many failures (any IP) sit in the sliding
   * window, logins from IPs that have never succeeded are admitted at most one
   * per `globalSlowdownIntervalMs` across all of them. This replaced a hard
   * global lockout, which let any stranger lock the owner out for hours; a
   * throttle caps distributed guessing just as well (each guess still needs the
   * passphrase *and* a live TOTP code) while the owner waits seconds at most.
   */
  globalMax: 20,
  globalWindowMs: 15 * 60_000,
  globalSlowdownIntervalMs: 10_000,
  /**
   * IPs (buckets) with a successful login skip the slowdown — otherwise a
   * fast attacker on many IPs could win every slot and still starve the owner.
   * They remain subject to the per-IP lockout.
   */
  knownGoodTtlMs: 30 * 24 * 60 * 60_000,
};

export class LoginGuard {
  private ips = new Map<string, IpState>();
  private globalFailures: number[] = [];
  private nextGlobalSlotAt = 0;
  private knownGood = new Map<string, number>();

  /** ms until this IP may try again (0 = allowed). */
  retryAfter(ip: string, now = Date.now()): number {
    const s = this.ips.get(ip);
    const i = s ? Math.max(0, s.lockedUntil - now) : 0;
    const g = this.throttles(ip, now) ? Math.max(0, this.nextGlobalSlotAt - now) : 0;
    return Math.max(g, i);
  }

  /** True while the global slowdown is in effect. */
  isSlowdown(now = Date.now()): boolean {
    const cutoff = now - LOGIN_POLICY.globalWindowMs;
    this.globalFailures = this.globalFailures.filter((t) => t > cutoff);
    return this.globalFailures.length >= LOGIN_POLICY.globalMax;
  }

  /** Claim the global slot for an attempt that passed `retryAfter` (no-op outside the slowdown). */
  admit(ip: string, now = Date.now()): void {
    if (this.throttles(ip, now)) this.nextGlobalSlotAt = now + LOGIN_POLICY.globalSlowdownIntervalMs;
  }

  private throttles(ip: string, now: number): boolean {
    if (!this.isSlowdown(now)) return false;
    const ok = this.knownGood.get(ip);
    return ok === undefined || now - ok > LOGIN_POLICY.knownGoodTtlMs;
  }

  /** Returns the per-IP lockout this failure triggered, and whether it started the global slowdown. */
  fail(ip: string, now = Date.now()): { ipLockMs: number; slowdownStarted: boolean } {
    const p = LOGIN_POLICY;
    let s = this.ips.get(ip);
    if (!s || now - s.lastFailure > p.ipForgetMs) s = { failures: 0, lastFailure: 0, lockedUntil: 0 };
    s.failures++;
    s.lastFailure = now;
    let ipLockMs = 0;
    if (s.failures >= p.perIpFree) {
      ipLockMs = Math.min(p.maxLockMs, p.baseLockMs * 2 ** (s.failures - p.perIpFree));
      s.lockedUntil = now + ipLockMs;
    }
    this.ips.set(ip, s);
    if (this.ips.size > 100_000) this.gc(now);

    const wasSlow = this.isSlowdown(now);
    this.globalFailures.push(now);
    // Bounded: once over the threshold, older entries only extend the window.
    if (this.globalFailures.length > p.globalMax * 4) this.globalFailures.splice(0, this.globalFailures.length - p.globalMax * 4);
    return { ipLockMs, slowdownStarted: !wasSlow && this.isSlowdown(now) };
  }

  succeed(ip: string, now = Date.now()): void {
    this.ips.delete(ip);
    this.knownGood.set(ip, now);
    if (this.knownGood.size > 1_000) {
      for (const [k, t] of this.knownGood) if (now - t > LOGIN_POLICY.knownGoodTtlMs) this.knownGood.delete(k);
    }
  }

  private gc(now: number): void {
    for (const [k, s] of this.ips) if (s.lockedUntil < now && now - s.lastFailure > LOGIN_POLICY.ipForgetMs) this.ips.delete(k);
  }
}

/** Serializes expensive scrypt work so a login flood can't exhaust memory/CPU. */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly maxQueue: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T | typeof Mutex.FULL> {
    if (this.waiting >= this.maxQueue) return Mutex.FULL;
    this.waiting++;
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      this.waiting--;
      release();
    }
  }
  static readonly FULL = Symbol("full");
}
