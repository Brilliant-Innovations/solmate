import { addAmounts, instantToMs, type Amount, type ExposureEffect, type Instant, type Nonce, type Uuid } from '@sol-agent-trader/contracts';

/**
 * The authorizer's own record of what it has signed (ADR-0009 P1; blueprint §13.7). Pending
 * exposure and in-flight counts come from here, not from the database, so a database that forgets
 * an authorization cannot make the authorizer sign the same capital twice. Entries expire with
 * their envelope or are consumed when the executor reports a terminal outcome.
 */

export interface IssuedAuthorization {
  nonce: Nonce;
  intentId: Uuid;
  actionCycleId: Uuid;
  sleeveId: Uuid | null;
  exposureEffect: ExposureEffect;
  maxInputAmount: Amount;
  issuedAt: Instant;
  expiresAt: Instant;
  consumedAt: Instant | null;
}

export class AuthorizationLedger {
  private readonly entries = new Map<Nonce, IssuedAuthorization>();
  private readonly byCycle = new Map<Uuid, Nonce>();

  issue(entry: IssuedAuthorization): void {
    if (this.entries.has(entry.nonce)) throw new Error(`nonce ${entry.nonce} already issued`);
    this.entries.set(entry.nonce, entry);
    this.byCycle.set(entry.actionCycleId, entry.nonce);
  }

  hasNonce(nonce: Nonce): boolean {
    return this.entries.has(nonce);
  }

  /** An action cycle is authorized at most once; a redelivery finds the existing envelope's nonce. */
  nonceForCycle(actionCycleId: Uuid): Nonce | null {
    return this.byCycle.get(actionCycleId) ?? null;
  }

  consume(nonce: Nonce, at: Instant): boolean {
    const e = this.entries.get(nonce);
    if (!e || e.consumedAt !== null) return false;
    this.entries.set(nonce, { ...e, consumedAt: at });
    return true;
  }

  private open(now: Instant): IssuedAuthorization[] {
    const t = instantToMs(now);
    return [...this.entries.values()].filter((e) => e.consumedAt === null && instantToMs(e.expiresAt) > t);
  }

  /** Unconsumed, unexpired exposure-increasing authorizations, optionally for one sleeve. */
  pendingExposure(now: Instant, sleeveId: Uuid | null = null): Amount {
    return this.open(now)
      .filter((e) => e.exposureEffect === 'INCREASE' && (sleeveId === null || e.sleeveId === sleeveId))
      .reduce((acc, e) => addAmounts(acc, e.maxInputAmount), '0' as Amount);
  }

  inFlightIncreasing(now: Instant): number {
    return this.open(now).filter((e) => e.exposureEffect === 'INCREASE').length;
  }

  size(): number {
    return this.entries.size;
  }
}
