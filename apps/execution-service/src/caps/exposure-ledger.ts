import { addAmounts, compareAmounts, subAmounts, type Amount, type Instant, type MintAddress, type ProtectionMode, type Uuid } from '@sol-agent-trader/contracts';

/**
 * ExecutorExposureLedger (blueprint §13.7, D33, D51; INV-08, INV-09). Append-only, built from
 * the executor's own observations, never from a database total: an authorized entry counts at
 * its authorized notional until its fill is confirmed, then at the larger of that notional and
 * the confirmed cost basis; exits and failures release it. MONITORED_EXIT lots are tracked
 * separately as signer-dependent exposure. Replayable from the journal after a restart.
 */

export type ExposureEvent =
  | { kind: 'ENTRY_AUTHORIZED'; at: Instant; intentId: Uuid; mint: MintAddress; notional: Amount; protectionMode: ProtectionMode }
  | { kind: 'ENTRY_CONFIRMED'; at: Instant; intentId: Uuid; costBasis: Amount }
  | { kind: 'ENTRY_RELEASED'; at: Instant; intentId: Uuid; reason: string }
  | { kind: 'EXIT_CONFIRMED'; at: Instant; intentId: Uuid; costReleased: Amount }
  | { kind: 'PROTECTION_CHANGED'; at: Instant; intentId: Uuid; protectionMode: ProtectionMode };

interface OpenEntry {
  mint: MintAddress;
  authorizedNotional: Amount;
  confirmedCostBasis: Amount | null;
  protectionMode: ProtectionMode;
}

export class ExecutorExposureLedger {
  private readonly events: ExposureEvent[] = [];
  private readonly open = new Map<Uuid, OpenEntry>();

  static replay(events: readonly ExposureEvent[]): ExecutorExposureLedger {
    const l = new ExecutorExposureLedger();
    for (const e of events) l.apply(e);
    return l;
  }

  apply(e: ExposureEvent): void {
    switch (e.kind) {
      case 'ENTRY_AUTHORIZED':
        if (this.open.has(e.intentId)) throw new Error(`intent ${e.intentId} already open in the exposure ledger`);
        this.open.set(e.intentId, { mint: e.mint, authorizedNotional: e.notional, confirmedCostBasis: null, protectionMode: e.protectionMode });
        break;
      case 'ENTRY_CONFIRMED': {
        const o = this.open.get(e.intentId);
        if (!o) throw new Error(`intent ${e.intentId} not open`);
        o.confirmedCostBasis = e.costBasis;
        break;
      }
      case 'ENTRY_RELEASED':
        this.open.delete(e.intentId);
        break;
      case 'EXIT_CONFIRMED': {
        const o = this.open.get(e.intentId);
        if (!o) break;
        const basis = o.confirmedCostBasis ?? o.authorizedNotional;
        const remaining = compareAmounts(basis, e.costReleased) > 0 ? subAmounts(basis, e.costReleased) : ('0' as Amount);
        if (remaining === '0') this.open.delete(e.intentId);
        else {
          o.confirmedCostBasis = remaining;
          o.authorizedNotional = remaining;
        }
        break;
      }
      case 'PROTECTION_CHANGED': {
        const o = this.open.get(e.intentId);
        if (o) o.protectionMode = e.protectionMode;
        break;
      }
    }
    this.events.push(e);
  }

  /** Conservative exposure per open entry: the larger of authorized notional and confirmed cost basis (§13.7). */
  private exposureOf(o: OpenEntry): Amount {
    return o.confirmedCostBasis !== null && compareAmounts(o.confirmedCostBasis, o.authorizedNotional) > 0 ? o.confirmedCostBasis : o.authorizedNotional;
  }

  aggregateNonSettlementExposure(): Amount {
    let total = '0' as Amount;
    for (const o of this.open.values()) total = addAmounts(total, this.exposureOf(o));
    return total;
  }

  signerDependentExposure(): Amount {
    let total = '0' as Amount;
    for (const o of this.open.values()) if (o.protectionMode === 'MONITORED_EXIT') total = addAmounts(total, this.exposureOf(o));
    return total;
  }

  openIntents(): Uuid[] {
    return [...this.open.keys()];
  }

  /** Open entries holding `mint`, with the exposure each currently counts for. */
  openByMint(mint: MintAddress): { intentId: Uuid; exposure: Amount }[] {
    return [...this.open.entries()].filter(([, o]) => o.mint === mint).map(([intentId, o]) => ({ intentId, exposure: this.exposureOf(o) }));
  }

  history(): readonly ExposureEvent[] {
    return this.events;
  }
}
