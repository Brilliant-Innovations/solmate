import type { Clock } from '@sol-agent-trader/contracts';

/**
 * Token-bucket rate limiter driven by an injected Clock (§18.2). `waitMs()` returns how long the
 * caller must wait before the next request is within the purchased rate; it never sleeps itself.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, Math.floor(ratePerSecond)),
  ) {
    if (!(ratePerSecond > 0)) throw new RangeError('ratePerSecond must be > 0');
    this.tokens = this.burst;
    this.lastRefillMs = clock.nowMs();
  }

  private refill(): void {
    const now = this.clock.nowMs();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /** Consumes one token if available; otherwise returns the wait in ms until one is. */
  take(): { ok: true } | { ok: false; waitMs: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const deficit = 1 - this.tokens;
    return { ok: false, waitMs: Math.ceil((deficit / this.ratePerSecond) * 1000) };
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/**
 * Compute-unit ledger for metered providers (Birdeye). Tracks spend inside the current calendar
 * month and refuses non-critical work once the purchased allowance is gone, so a discovery loop
 * can never starve the active-position price feed (§21.1, D43 spirit).
 */
export interface LedgerState {
  month: string;
  used: number;
  byEndpoint: Record<string, number>;
}

/** Called after every charge so the process can persist spend; a restart then resumes, never resets. */
export type LedgerSink = (charge: { month: string; endpoint: string; cu: number; usedAfter: number }) => void;

export class ComputeUnitLedger {
  private monthKey: string;
  private used = 0;
  private readonly byEndpoint = new Map<string, number>();
  private sink: LedgerSink | null = null;

  constructor(
    private readonly clock: Clock,
    /** null = unmetered. */
    readonly monthlyAllowance: number | null,
    /** Fraction of the allowance reserved for CRITICAL requests (active-position prices). */
    private readonly criticalReserve = 0.1,
  ) {
    this.monthKey = ComputeUnitLedger.monthOf(clock.nowMs());
  }

  /** Month key for a clock instant, UTC calendar month (Birdeye meters per calendar month). */
  static monthKeyFor(ms: number): string {
    return ComputeUnitLedger.monthOf(ms);
  }

  /** Loads persisted spend. Ignored when the persisted month is not the current one (a rollover already happened). */
  restore(state: LedgerState): void {
    if (state.month !== ComputeUnitLedger.monthOf(this.clock.nowMs())) return;
    this.monthKey = state.month;
    this.used = Math.max(0, state.used);
    this.byEndpoint.clear();
    for (const [endpoint, cu] of Object.entries(state.byEndpoint)) this.byEndpoint.set(endpoint, cu);
  }

  onCharge(sink: LedgerSink | null): void {
    this.sink = sink;
  }

  private static monthOf(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private rollover(): void {
    const key = ComputeUnitLedger.monthOf(this.clock.nowMs());
    if (key !== this.monthKey) {
      this.monthKey = key;
      this.used = 0;
      this.byEndpoint.clear();
    }
  }

  /** Whether a request costing `cu` may proceed at the given priority. */
  allows(cu: number, priority: 'CRITICAL' | 'NORMAL'): boolean {
    this.rollover();
    if (this.monthlyAllowance === null) return true;
    const ceiling = priority === 'CRITICAL' ? this.monthlyAllowance : this.monthlyAllowance * (1 - this.criticalReserve);
    return this.used + cu <= ceiling;
  }

  charge(endpoint: string, cu: number): void {
    this.rollover();
    this.used += cu;
    this.byEndpoint.set(endpoint, (this.byEndpoint.get(endpoint) ?? 0) + cu);
    this.sink?.({ month: this.monthKey, endpoint, cu, usedAfter: this.used });
  }

  snapshot(): { month: string; used: number; allowance: number | null; remaining: number | null; byEndpoint: Record<string, number> } {
    this.rollover();
    return {
      month: this.monthKey,
      used: this.used,
      allowance: this.monthlyAllowance,
      remaining: this.monthlyAllowance === null ? null : Math.max(0, this.monthlyAllowance - this.used),
      byEndpoint: Object.fromEntries(this.byEndpoint),
    };
  }
}
