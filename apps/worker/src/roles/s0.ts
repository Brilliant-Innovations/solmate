import { randomUUID } from 'node:crypto';
import { instantToMs, type Candidate, type Clock, type FeatureSnapshot, type Instant, type ReasonCode, type S0SafetyGatePolicy, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { decideS0, expireS0, type S0Decision } from '@sol-agent-trader/strategies';
import type { ActionCycle } from '@sol-agent-trader/contracts';

/**
 * Worker role `s0` (blueprint §12.1, D30; execution plan M5a). For every DETECTED candidate not
 * yet decided by S0_SAFE, run both variants over the candidate's stored feature snapshot and
 * persist RAW and SAFE action cycles together. The SAFE outcome moves the candidate: CLEARED →
 * QUALIFIED (the paper adapter's input, next package), REJECTED → REJECTED with the first gate
 * objection as the deterministic reason. Nothing here calls a provider or an LLM.
 */

export interface S0Repo {
  listAwaiting(strategyVersionId: StrategyVersion['versionId'], now: Instant, limit: number): Promise<{ candidate: Candidate; snapshot: FeatureSnapshot }[]>;
  persist(candidateId: Uuid, decisions: S0Decision[], status: 'QUALIFIED' | 'REJECTED', reason: ReasonCode | null): Promise<void>;
  /** D32: EXPIRED cycles for a candidate that outlived the strategy's candidate-age contract. */
  persistExpired(candidateId: Uuid, cycles: ActionCycle[]): Promise<void>;
}

export interface S0Deps {
  repo: S0Repo;
  clock: Clock;
  logger: Logger;
  strategies: { RAW: StrategyVersion; SAFE: StrategyVersion };
  gatePolicy: S0SafetyGatePolicy;
  config: { batchSize: number };
}

export interface S0CycleReport {
  scanned: number;
  cleared: number;
  rejected: number;
  expired: number;
  rejectionsByCode: Record<string, number>;
  errors: { candidateId: Uuid; error: string }[];
}

export async function runS0Cycle(deps: S0Deps): Promise<S0CycleReport> {
  const now = deps.clock.now();
  const report: S0CycleReport = { scanned: 0, cleared: 0, rejected: 0, expired: 0, rejectionsByCode: {}, errors: [] };
  const awaiting = await deps.repo.listAwaiting(deps.strategies.SAFE.versionId, now, deps.config.batchSize);
  report.scanned = awaiting.length;
  for (const { candidate, snapshot } of awaiting) {
    try {
      const age = instantToMs(now) - instantToMs(candidate.discoveredAt);
      if (age > deps.strategies.SAFE.maxCandidateAgeMs) {
        const cycles = [expireS0({ cycleId: randomUUID() as Uuid, candidate, strategy: deps.strategies.RAW, now }), expireS0({ cycleId: randomUUID() as Uuid, candidate, strategy: deps.strategies.SAFE, now })];
        await deps.repo.persistExpired(candidate.id, cycles);
        report.expired++;
        deps.logger.info('s0_expired', { candidateId: candidate.id, assetId: candidate.assetId, ageMs: age, maxCandidateAgeMs: deps.strategies.SAFE.maxCandidateAgeMs, cycleIds: cycles.map((c) => c.id) });
        continue;
      }
      const ids = () => ({ cycleId: randomUUID() as Uuid, proposalId: randomUUID() as Uuid, reviewId: randomUUID() as Uuid });
      const raw = decideS0({ variant: 'RAW', ids: ids(), candidate, snapshot, strategy: deps.strategies.RAW, gatePolicy: deps.gatePolicy, now });
      const safe = decideS0({ variant: 'SAFE', ids: ids(), candidate, snapshot, strategy: deps.strategies.SAFE, gatePolicy: deps.gatePolicy, now });
      const cleared = safe.cycle.state === 'CLEARED';
      const reason = cleared ? null : (safe.gate.objections[0]?.code ?? null);
      await deps.repo.persist(candidate.id, [raw, safe], cleared ? 'QUALIFIED' : 'REJECTED', reason);
      if (cleared) report.cleared++;
      else {
        report.rejected++;
        for (const o of safe.gate.objections) report.rejectionsByCode[o.code] = (report.rejectionsByCode[o.code] ?? 0) + 1;
      }
      deps.logger.info('s0_decided', { candidateId: candidate.id, assetId: candidate.assetId, safeCycleId: safe.cycle.id, rawCycleId: raw.cycle.id, safeState: safe.cycle.state, objections: safe.gate.objections.map((o) => o.code), score: candidate.scannerScore });
    } catch (err) {
      report.errors.push({ candidateId: candidate.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.logger.info('s0_cycle', { scanned: report.scanned, cleared: report.cleared, rejected: report.rejected, expired: report.expired, rejectionsByCode: report.rejectionsByCode, errors: report.errors.length, gate: deps.gatePolicy.version });
  for (const e of report.errors) deps.logger.warn('s0_candidate_failed', { candidateId: e.candidateId, error: e.error });
  return report;
}
