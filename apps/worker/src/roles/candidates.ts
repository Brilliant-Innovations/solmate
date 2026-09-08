import { randomUUID } from 'node:crypto';
import type { AssetEligibility, Candidate, Clock, EarlyAccelerationTriggerPolicy, EligibilityPolicy, FeatureEngineSpec, FeatureSnapshot, Instant, MomentumTriggerPolicy, SelfInfluencePolicy, TriggerFamily, Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { entryAllowed } from '@sol-agent-trader/risk';
import { detectEarlyAccelerationCandidate, detectMomentumCandidate, isWarm, suppressionWindow, type DetectorDecision, type OwnFill } from '@sol-agent-trader/signals';

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
  earlyAcceleration: EarlyAccelerationTriggerPolicy;
  eligibility: EligibilityPolicy;
  selfInfluence: SelfInfluencePolicy;
  config: { batchSize: number };
}

export interface CandidatesCycleReport {
  scanned: number;
  detected: number;
  rejected: number;
  skipped: Record<'FEATURES_COLD' | 'NO_TRIGGER' | 'DEDUPED' | 'COOLDOWN', number>;
  byFamily: Record<'MOMENTUM_CONTINUATION' | 'EARLY_ACCELERATION', { detected: number; rejected: number }>;
  expired: number;
  errors: { assetId: Uuid; error: string }[];
}

export async function runCandidatesCycle(deps: CandidatesDeps): Promise<CandidatesCycleReport> {
  const now = deps.clock.now();
  const report: CandidatesCycleReport = { scanned: 0, detected: 0, rejected: 0, skipped: { FEATURES_COLD: 0, NO_TRIGGER: 0, DEDUPED: 0, COOLDOWN: 0 }, byFamily: { MOMENTUM_CONTINUATION: { detected: 0, rejected: 0 }, EARLY_ACCELERATION: { detected: 0, rejected: 0 } }, expired: 0, errors: [] };
  report.expired = await deps.repo.expireCandidates(now);
  const owned = new Set((await deps.repo.listOwnedAddresses()).map((o) => o.address));
  const solReturn = await deps.repo.solReturn1h(now);
  const inputs = await deps.repo.listScanInputs(deps.config.batchSize);
  report.scanned = inputs.length;

  for (const { snapshot, eligibilityEvaluationId } of inputs) {
    try {
      // Warm-up is an asset-level fact (D63): counted once, whatever the number of families.
      if (!isWarm(snapshot, deps.spec).warm) {
        report.skipped.FEATURES_COLD++;
        continue;
      }
      const families: ('MOMENTUM_CONTINUATION' | 'EARLY_ACCELERATION')[] = ['MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION'];
      const [record, openMomentum, openEarly, lastMomentum, lastEarly, fills] = await Promise.all([
        deps.repo.latestEligibility(snapshot.assetId),
        deps.repo.listOpenCandidates(snapshot.assetId, 'MOMENTUM_CONTINUATION'),
        deps.repo.listOpenCandidates(snapshot.assetId, 'EARLY_ACCELERATION'),
        deps.repo.lastTerminalCandidateAt(snapshot.assetId, 'MOMENTUM_CONTINUATION'),
        deps.repo.lastTerminalCandidateAt(snapshot.assetId, 'EARLY_ACCELERATION'),
        deps.repo.recentOwnFills(snapshot.assetId, new Date(Date.parse(now) - deps.selfInfluence.maxWindowMs).toISOString() as Instant),
      ]);
      // §9.7: related triggers aggregate — any open candidate on the asset, whatever its family, dedupes the others.
      const open = [...openMomentum, ...openEarly];
      const lastTerminal: Record<TriggerFamily, Instant | null> = { MOMENTUM_CONTINUATION: lastMomentum, EARLY_ACCELERATION: lastEarly } as Record<TriggerFamily, Instant | null>;
      const gate = entryAllowed(record, now, deps.eligibility);
      const own1h = snapshot.features['ret_1h'];
      const solRelative = typeof own1h === 'number' && solReturn !== null ? own1h - solReturn : null;
      const context = {
        newId: () => randomUUID() as Uuid,
        now,
        snapshot,
        spec: deps.spec,
        solRelativeReturn1h: solRelative,
        entryGate: { allowed: gate.allowed, reason: gate.allowed ? null : gate.reason, eligibilityEvaluationId },
        selfInfluence: { isOwned: (a: string) => owned.has(a), ownSignatures: new Set(fills.map((f) => f.signature)), windows: fills.map((f) => suppressionWindow(deps.selfInfluence, f)), now },
      };
      let raisedThisCycle: Pick<Candidate, 'dedupeKey' | 'discoveredAt'>[] = [];
      for (const family of families) {
        const decision: DetectorDecision = family === 'MOMENTUM_CONTINUATION'
          ? detectMomentumCandidate({ ...context, policy: deps.trigger, openCandidates: [...open, ...raisedThisCycle], lastTerminalAt: lastTerminal[family] })
          : detectEarlyAccelerationCandidate({ ...context, policy: deps.earlyAcceleration, openCandidates: [...open, ...raisedThisCycle], lastTerminalAt: lastTerminal[family] });
        if (decision.kind === 'SKIP') {
          report.skipped[decision.reason]++;
          continue;
        }
        await deps.repo.insertCandidate(decision.candidate);
        if (decision.kind === 'CANDIDATE') {
          report.detected++;
          report.byFamily[family].detected++;
          raisedThisCycle = [...raisedThisCycle, { dedupeKey: decision.candidate.dedupeKey, discoveredAt: decision.candidate.discoveredAt }];
          deps.logger.info('candidate_detected', { candidateId: decision.candidate.id, assetId: snapshot.assetId, family, score: decision.candidate.scannerScore, passed: decision.evaluation.passed, expiresAt: decision.candidate.expiresAt });
        } else {
          report.rejected++;
          report.byFamily[family].rejected++;
          deps.logger.info('candidate_rejected', { candidateId: decision.candidate.id, assetId: snapshot.assetId, family, score: decision.candidate.scannerScore, reason: decision.reason });
        }
      }
    } catch (err) {
      report.errors.push({ assetId: snapshot.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('candidates_cycle', { scanned: report.scanned, detected: report.detected, rejected: report.rejected, ...report.skipped, byFamily: report.byFamily, expired: report.expired, errors: report.errors.length, triggers: [deps.trigger.version, deps.earlyAcceleration.version] });
  for (const e of report.errors) deps.logger.warn('candidates_asset_failed', { assetId: e.assetId, error: e.error });
  return report;
}
