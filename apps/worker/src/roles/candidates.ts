import { randomUUID } from 'node:crypto';
import type { AssetEligibility, Candidate, Clock, EligibilityPolicy, FeatureEngineSpec, FeatureSnapshot, Instant, MomentumTriggerPolicy, SelfInfluencePolicy, TriggerFamily, Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { entryAllowed } from '@sol-agent-trader/risk';
import { detectMomentumCandidate, suppressionWindow, type OwnFill } from '@sol-agent-trader/signals';

/**
 * Worker role `candidates` (blueprint §6.9, §9.1, §9.7, §8.6, D63; execution plan M5a). Every
 * cycle: expire stale candidates, then for each ELIGIBLE asset's latest feature vector run the
 * deterministic momentum trigger under the entry-eligibility gate (INV-03) and the self-influence
 * guard (INV-11), with dedupe and cooldown from what is already recorded. Fired-but-refused
 * triggers are persisted as REJECTED candidates so filter value stays measurable. Nothing here
 * trades: DETECTED hands the candidate to a strategy's action cycle (next package).
 */

export interface CandidatesRepo {
  listScanInputs(limit: number): Promise<{ snapshot: FeatureSnapshot; eligibilityEvaluationId: Uuid }[]>;
  latestEligibility(assetId: Uuid): Promise<AssetEligibility | null>;
  listOpenCandidates(assetId: Uuid, family: TriggerFamily): Promise<Pick<Candidate, 'dedupeKey' | 'discoveredAt'>[]>;
  lastTerminalCandidateAt(assetId: Uuid, family: TriggerFamily): Promise<Instant | null>;
  insertCandidate(candidate: Candidate): Promise<void>;
  expireCandidates(now: Instant): Promise<number>;
  /** Our own fills for the asset inside the suppression horizon (§8.6); empty until the paper book exists. */
  recentOwnFills(assetId: Uuid, since: Instant): Promise<OwnFill[]>;
  listOwnedAddresses(): Promise<{ address: string }[]>;
  /** SOL 1h return for relative strength, when the SOL asset is tracked. */
  solReturn1h(asOf: Instant): Promise<number | null>;
}

export interface CandidatesDeps {
  repo: CandidatesRepo;
  clock: Clock;
  logger: Logger;
  spec: FeatureEngineSpec;
  trigger: MomentumTriggerPolicy;
  eligibility: EligibilityPolicy;
  selfInfluence: SelfInfluencePolicy;
  config: { batchSize: number };
}

export interface CandidatesCycleReport {
  scanned: number;
  detected: number;
  rejected: number;
  skipped: Record<'FEATURES_COLD' | 'NO_TRIGGER' | 'DEDUPED' | 'COOLDOWN', number>;
  expired: number;
  errors: { assetId: Uuid; error: string }[];
}

export async function runCandidatesCycle(deps: CandidatesDeps): Promise<CandidatesCycleReport> {
  const now = deps.clock.now();
  const report: CandidatesCycleReport = { scanned: 0, detected: 0, rejected: 0, skipped: { FEATURES_COLD: 0, NO_TRIGGER: 0, DEDUPED: 0, COOLDOWN: 0 }, expired: 0, errors: [] };
  report.expired = await deps.repo.expireCandidates(now);
  const owned = new Set((await deps.repo.listOwnedAddresses()).map((o) => o.address));
  const solReturn = await deps.repo.solReturn1h(now);
  const inputs = await deps.repo.listScanInputs(deps.config.batchSize);
  report.scanned = inputs.length;

  for (const { snapshot, eligibilityEvaluationId } of inputs) {
    try {
      const family: TriggerFamily = 'MOMENTUM_CONTINUATION';
      const [record, open, lastTerminalAt, fills] = await Promise.all([
        deps.repo.latestEligibility(snapshot.assetId),
        deps.repo.listOpenCandidates(snapshot.assetId, family),
        deps.repo.lastTerminalCandidateAt(snapshot.assetId, family),
        deps.repo.recentOwnFills(snapshot.assetId, new Date(Date.parse(now) - deps.selfInfluence.maxWindowMs).toISOString() as Instant),
      ]);
      const gate = entryAllowed(record, now, deps.eligibility);
      const own1h = snapshot.features['ret_1h'];
      const solRelative = typeof own1h === 'number' && solReturn !== null ? own1h - solReturn : null;
      const decision = detectMomentumCandidate({
        newId: () => randomUUID() as Uuid,
        now,
        snapshot,
        spec: deps.spec,
        policy: deps.trigger,
        solRelativeReturn1h: solRelative,
        entryGate: { allowed: gate.allowed, reason: gate.allowed ? null : gate.reason, eligibilityEvaluationId },
        selfInfluence: { isOwned: (a) => owned.has(a), ownSignatures: new Set(fills.map((f) => f.signature)), windows: fills.map((f) => suppressionWindow(deps.selfInfluence, f)), now },
        openCandidates: open,
        lastTerminalAt,
      });
      if (decision.kind === 'SKIP') {
        report.skipped[decision.reason]++;
        continue;
      }
      await deps.repo.insertCandidate(decision.candidate);
      if (decision.kind === 'CANDIDATE') {
        report.detected++;
        deps.logger.info('candidate_detected', { candidateId: decision.candidate.id, assetId: snapshot.assetId, score: decision.candidate.scannerScore, passed: decision.evaluation.passed, expiresAt: decision.candidate.expiresAt });
      } else {
        report.rejected++;
        deps.logger.info('candidate_rejected', { candidateId: decision.candidate.id, assetId: snapshot.assetId, score: decision.candidate.scannerScore, reason: decision.reason });
      }
    } catch (err) {
      report.errors.push({ assetId: snapshot.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('candidates_cycle', { scanned: report.scanned, detected: report.detected, rejected: report.rejected, ...report.skipped, expired: report.expired, errors: report.errors.length, trigger: deps.trigger.version });
  for (const e of report.errors) deps.logger.warn('candidates_asset_failed', { assetId: e.assetId, error: e.error });
  return report;
}
