import { randomUUID } from 'node:crypto';
import { addMs, type AssetStatus, type AssetEligibility, type Clock, type EligibilityPolicy, type MintAddress, type TokenOverview, type TokenSecurityReport, type Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { BudgetExhaustedError, type BirdeyeClient } from '@sol-agent-trader/market';
import { evaluateEligibility } from '@sol-agent-trader/risk';
import { MintNotFoundError, readMintChainState, type SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';

/**
 * Worker role `eligibility` (blueprint §7, D45; execution plan M4). For every asset due for
 * evaluation: read hard protocol state from chain (authoritative), fetch the analytics security
 * report and market overview (corroboration, market structure), run the deterministic engine and
 * persist the record with the derived status in one transaction. Route probes arrive with the
 * Jupiter quote adapter; until then every evaluation fails closed as EVALUATING, never ELIGIBLE.
 */

export interface EligibilityRepo {
  listAssetsForEvaluation(opts: { limit: number; reevaluateAfter: ReturnType<Clock['now']> }): Promise<{ id: Uuid; mintAddress: string; status: AssetStatus }[]>;
  recordEligibility(record: AssetEligibility, status: AssetStatus): Promise<void>;
}

export interface EligibilityDeps {
  rpc: SolanaRpcClient;
  birdeye: BirdeyeClient;
  repo: EligibilityRepo;
  clock: Clock;
  logger: Logger;
  policy: EligibilityPolicy;
  config: {
    batchSize: number;
    /** Re-evaluate anything older than this (§7.4 periodic refresh). */
    reevaluateAfterMs: number;
  };
}

export interface EligibilityCycleReport {
  considered: number;
  evaluated: number;
  outcomes: Record<'ELIGIBLE' | 'BLOCKED' | 'EVALUATING', number>;
  errors: { assetId: Uuid; step: 'CHAIN' | 'SECURITY' | 'OVERVIEW' | 'PERSIST'; error: string }[];
  budgetExhausted: boolean;
}

export async function runEligibilityCycle(deps: EligibilityDeps): Promise<EligibilityCycleReport> {
  const now = deps.clock.now();
  const report: EligibilityCycleReport = { considered: 0, evaluated: 0, outcomes: { ELIGIBLE: 0, BLOCKED: 0, EVALUATING: 0 }, errors: [], budgetExhausted: false };
  const due = await deps.repo.listAssetsForEvaluation({ limit: deps.config.batchSize, reevaluateAfter: addMs(now, -deps.config.reevaluateAfterMs) });
  report.considered = due.length;

  for (const asset of due) {
    const mint = asset.mintAddress as MintAddress;
    let chain;
    try {
      chain = await readMintChainState(deps.rpc, mint, deps.clock);
    } catch (err) {
      report.errors.push({ assetId: asset.id, step: 'CHAIN', error: err instanceof MintNotFoundError ? 'mint account not found' : err instanceof Error ? err.message : String(err) });
      continue;
    }

    let security: TokenSecurityReport | null = null;
    try {
      security = (await deps.birdeye.security(mint)).security;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      report.errors.push({ assetId: asset.id, step: 'SECURITY', error: err instanceof Error ? err.message : String(err) });
    }
    let overview: TokenOverview | null = null;
    try {
      overview = (await deps.birdeye.overview(mint)).overview;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        report.budgetExhausted = true;
        break;
      }
      report.errors.push({ assetId: asset.id, step: 'OVERVIEW', error: err instanceof Error ? err.message : String(err) });
    }

    const result = evaluateEligibility({
      id: randomUUID() as Uuid,
      assetId: asset.id,
      chain,
      security,
      overview,
      probes: [],
      settlementRouteConfirmed: null,
      now: deps.clock.now(),
      policy: deps.policy,
    });
    try {
      await deps.repo.recordEligibility(result.record, result.outcome);
      report.evaluated++;
      report.outcomes[result.outcome]++;
    } catch (err) {
      report.errors.push({ assetId: asset.id, step: 'PERSIST', error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('eligibility_cycle', { considered: report.considered, evaluated: report.evaluated, ...report.outcomes, errors: report.errors.length, budgetExhausted: report.budgetExhausted, cu: deps.birdeye.ledger.snapshot().used });
  for (const e of report.errors) deps.logger.warn('eligibility_step_failed', { assetId: e.assetId, step: e.step, error: e.error });
  return report;
}
