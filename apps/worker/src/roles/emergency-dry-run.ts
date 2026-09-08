import { randomUUID } from 'node:crypto';
import { instantToMs, type Amount, type Clock, type EmergencyExitRouteSnapshot, type EmergencyRoutePolicy, type Instant, type MintAddress, type Slot, type Uuid } from '@sol-agent-trader/contracts';
import type { DryRunTarget } from '@sol-agent-trader/db/server';
import type { DirectPoolAdapter, DryRunResult, EmergencyBuild, SimulationReader } from '@sol-agent-trader/execution';
import { runEmergencyDryRun } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `emergency-dry-run` (blueprint §14.6, D33; plan M8b). For every held or
 * LIVE_AUTO-eligible asset with a persisted direct-pool snapshot, rebuild the emergency exit
 * transaction from fresh pool state, simulate it unsigned with the trading wallet as payer, and
 * append a new snapshot row carrying the refreshed capacity and the dry-run verdict. The
 * authorizer denies LIVE_AUTO entries whose asset has no fresh, successful dry-run; the safety
 * role keeps using the snapshot's pool for `canReduceNow`. Nothing here signs or submits.
 */

export interface EmergencyDryRunRepo {
  targets(limit: number): Promise<DryRunTarget[]>;
  latestSnapshots(assetIds: readonly Uuid[]): Promise<Map<Uuid, EmergencyExitRouteSnapshot>>;
  insertSnapshot(snapshot: EmergencyExitRouteSnapshot): Promise<void>;
}

export interface EmergencyDryRunDeps {
  repo: EmergencyDryRunRepo;
  reader: SimulationReader;
  /** The trading wallet: fee payer and token-account owner of the simulated close of a held asset. */
  tradingWallet: string;
  /**
   * For an asset the wallet does not hold, the simulation runs as the mint's largest holder
   * (signatures are not verified in simulation), so the swap itself is exercised rather than
   * stopping at the missing source account. Null → the trading wallet is used anyway.
   */
  standInPayer?: (mint: MintAddress) => Promise<string | null>;
  policy: EmergencyRoutePolicy;
  adapters?: readonly DirectPoolAdapter[];
  clock: Clock;
  logger: Logger;
  newId?: () => Uuid;
  config: { dryRunSlippageBps?: number };
}

export interface EmergencyDryRunReport {
  targets: number;
  due: number;
  ran: number;
  outcomes: Record<string, number>;
  unsupported: number;
  noSnapshot: number;
  errors: { assetId: Uuid; error: string }[];
}

/** The input size a dry-run proves: the smallest persisted capacity probe, else one whole token. */
export function dryRunAmount(snapshot: EmergencyExitRouteSnapshot, decimals: number): bigint {
  const sizes = snapshot.capacity.map((c) => BigInt(c.inputAmount)).filter((n) => n > 0n);
  if (sizes.length) return sizes.reduce((m, n) => (n < m ? n : m));
  return 10n ** BigInt(Math.min(decimals, 18));
}

function refreshedCapacity(snapshot: EmergencyExitRouteSnapshot, build: EmergencyBuild | null): EmergencyExitRouteSnapshot['capacity'] {
  if (!build) return snapshot.capacity;
  const out: EmergencyExitRouteSnapshot['capacity'] = [];
  for (const c of snapshot.capacity) {
    try {
      const q = build.adapter.quote(build.state, build.quote.inputMint, BigInt(c.inputAmount));
      out.push({ inputAmount: c.inputAmount, expectedOutputAmount: q.expectedOutputAmount, impactBps: q.impactBps });
    } catch {
      out.push(c);
    }
  }
  return out;
}

export async function runEmergencyDryRunCycle(deps: EmergencyDryRunDeps): Promise<EmergencyDryRunReport> {
  const now = deps.clock.now();
  const newId = deps.newId ?? (() => randomUUID() as Uuid);
  const report: EmergencyDryRunReport = { targets: 0, due: 0, ran: 0, outcomes: {}, unsupported: 0, noSnapshot: 0, errors: [] };
  const targets = await deps.repo.targets(deps.policy.maxTargetsPerCycle);
  report.targets = targets.length;
  const due = targets.filter((t) => t.lastDryRunAt === null || instantToMs(now) - instantToMs(t.lastDryRunAt) >= deps.policy.dryRunIntervalMs);
  report.due = due.length;
  if (due.length === 0) {
    deps.logger.info('emergency_dry_run_cycle', { ...report });
    return report;
  }
  const snapshots = await deps.repo.latestSnapshots(due.map((t) => t.assetId));
  for (const t of due) {
    const snapshot = snapshots.get(t.assetId) ?? null;
    if (!snapshot) {
      report.noSnapshot++;
      continue;
    }
    const hop = snapshot.hops[0];
    if (!hop) {
      report.noSnapshot++;
      continue;
    }
    try {
      const amountIn = dryRunAmount(snapshot, t.decimals);
      let user = deps.tradingWallet;
      let payerKind: 'TRADING_WALLET' | 'STAND_IN_HOLDER' = 'TRADING_WALLET';
      if (!t.held && deps.standInPayer && deps.policy.supportedPrograms.includes(hop.program)) {
        const holder = await deps.standInPayer(t.mint).catch(() => null);
        if (holder) {
          user = holder;
          payerKind = 'STAND_IN_HOLDER';
        }
      }
      const r: DryRunResult & { build: EmergencyBuild | null } = await runEmergencyDryRun({
        hop, user, amountIn, slippageBps: deps.config.dryRunSlippageBps ?? deps.policy.dryRunSlippageBps, policy: deps.policy, reader: deps.reader, adapters: deps.adapters, now,
      });
      report.ran++;
      report.outcomes[r.class] = (report.outcomes[r.class] ?? 0) + 1;
      if (r.class === 'UNSUPPORTED_PROGRAM') report.unsupported++;
      const refreshed: EmergencyExitRouteSnapshot = {
        ...snapshot,
        id: newId(),
        lastRefreshedAt: r.slot !== null ? now : snapshot.lastRefreshedAt,
        lastRefreshSlot: r.slot !== null ? (r.slot as Slot) : snapshot.lastRefreshSlot,
        poolStateRef: r.slot !== null ? `slot:${r.slot}` : snapshot.poolStateRef,
        capacity: refreshedCapacity(snapshot, r.build),
        lastDryRun: { at: now, ok: r.ok, simulatedOutputAmount: r.simulatedOutputAmount, error: r.error === null ? null : `${r.class}: ${r.error}`.slice(0, 500) },
      };
      await deps.repo.insertSnapshot(refreshed);
      const line = { assetId: t.assetId, mint: t.mint, held: t.held, payerKind, program: hop.program, pool: hop.poolAddress, class: r.class, ok: r.ok, amountIn: amountIn.toString(), expectedOut: r.quote?.expectedOutputAmount ?? null, simulatedOut: r.simulatedOutputAmount, impactBps: r.quote?.impactBps ?? null, unitsConsumed: r.unitsConsumed, slot: r.slot, error: r.error };
      if (r.ok) deps.logger.info('emergency_dry_run', line);
      else if (t.held) deps.logger.error('emergency_dry_run_failed_held_asset', line);
      else deps.logger.warn('emergency_dry_run_failed', line);
    } catch (err) {
      report.errors.push({ assetId: t.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.logger.info('emergency_dry_run_cycle', { ...report, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('emergency_dry_run_error', e);
  return report;
}

export type { Amount, Instant };
