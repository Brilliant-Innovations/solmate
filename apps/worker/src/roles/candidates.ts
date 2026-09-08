import { randomUUID } from 'node:crypto';
import type { AssetEligibility, Candidate, CatalystTriggerPolicy, Clock, EarlyAccelerationTriggerPolicy, EligibilityPolicy, FeatureEngineSpec, FeatureSnapshot, HybridTriggerPolicy, Instant, MomentumTriggerPolicy, SelfInfluencePolicy, SmartMoneyTriggerPolicy, TriggerFamily, Uuid } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { entryAllowed } from '@sol-agent-trader/risk';
import { detectCatalystCandidate, detectEarlyAccelerationCandidate, detectHybridCandidate, detectMomentumCandidate, detectSmartMoneyCandidate, isWarm, suppressionWindow, type CatalystEvidence, type DetectorDecision, type FamilySignal, type OwnFill, type SmartMoneyFlowFacts } from '@sol-agent-trader/signals';

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
  /** Events visible at `now` for the asset (first seen at or before now), for the catalyst family; empty until intelligence ingests. */
  visibleEvents(assetId: Uuid, now: Instant, limit: number): Promise<CatalystEvidence[]>;
  /** Tracked-wallet flow with owned wallets excluded, for the smart-money family; null when no wallet is tracked. */
  smartMoneyFlow(assetId: Uuid, now: Instant): Promise<SmartMoneyFlowFacts | null>;
  /** Other families' recent detections on the asset, for the hybrid family. */
  recentFamilySignals(assetId: Uuid, since: Instant): Promise<FamilySignal[]>;
}

export interface CandidatesDeps {
  repo: CandidatesRepo;
  clock: Clock;
  logger: Logger;
  spec: FeatureEngineSpec;
  trigger: MomentumTriggerPolicy;
  earlyAcceleration: EarlyAccelerationTriggerPolicy;
  catalyst: CatalystTriggerPolicy;
  smartMoney: SmartMoneyTriggerPolicy;
  hybrid: HybridTriggerPolicy;
  eligibility: EligibilityPolicy;
  selfInfluence: SelfInfluencePolicy;
  config: { batchSize: number };
}

export type ScanFamily = 'MOMENTUM_CONTINUATION' | 'EARLY_ACCELERATION' | 'CATALYST_RESPONSE' | 'SMART_MONEY_ACCUMULATION' | 'HOLDER_LIQUIDITY_EXPANSION';
export const SCAN_FAMILIES: readonly ScanFamily[] = ['MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION', 'CATALYST_RESPONSE', 'SMART_MONEY_ACCUMULATION', 'HOLDER_LIQUIDITY_EXPANSION'];

export interface CandidatesCycleReport {
  scanned: number;
  detected: number;
  rejected: number;
  skipped: Record<'FEATURES_COLD' | 'NO_TRIGGER' | 'DEDUPED' | 'COOLDOWN', number>;
  byFamily: Record<ScanFamily, { detected: number; rejected: number }>;
  expired: number;
  errors: { assetId: Uuid; error: string }[];
}

export async function runCandidatesCycle(deps: CandidatesDeps): Promise<CandidatesCycleReport> {
  const now = deps.clock.now();
  const report: CandidatesCycleReport = { scanned: 0, detected: 0, rejected: 0, skipped: { FEATURES_COLD: 0, NO_TRIGGER: 0, DEDUPED: 0, COOLDOWN: 0 }, byFamily: Object.fromEntries(SCAN_FAMILIES.map((f) => [f, { detected: 0, rejected: 0 }])) as CandidatesCycleReport['byFamily'], expired: 0, errors: [] };
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
      const families = SCAN_FAMILIES;
      const [record, fills, openByFamily, lastByFamily, events, flow, familySignals] = await Promise.all([
        deps.repo.latestEligibility(snapshot.assetId),
        deps.repo.recentOwnFills(snapshot.assetId, new Date(Date.parse(now) - deps.selfInfluence.maxWindowMs).toISOString() as Instant),
        Promise.all(families.map((f) => deps.repo.listOpenCandidates(snapshot.assetId, f))),
        Promise.all(families.map((f) => deps.repo.lastTerminalCandidateAt(snapshot.assetId, f))),
        deps.repo.visibleEvents(snapshot.assetId, now, 50),
        deps.repo.smartMoneyFlow(snapshot.assetId, now),
        deps.repo.recentFamilySignals(snapshot.assetId, new Date(Date.parse(now) - deps.hybrid.alignmentWindowMs).toISOString() as Instant),
      ]);
      // §9.7: related triggers aggregate — any open candidate on the asset, whatever its family, dedupes the others.
      const open = openByFamily.flat();
      const lastTerminal = Object.fromEntries(families.map((f, i) => [f, lastByFamily[i] ?? null])) as Record<TriggerFamily, Instant | null>;
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
      const raisedSignals: FamilySignal[] = [];
      for (const family of families) {
        const shared = { ...context, openCandidates: [...open, ...raisedThisCycle], lastTerminalAt: lastTerminal[family] };
        let decision: DetectorDecision;
        switch (family) {
          case 'MOMENTUM_CONTINUATION':
            decision = detectMomentumCandidate({ ...shared, policy: deps.trigger });
            break;
          case 'EARLY_ACCELERATION':
            decision = detectEarlyAccelerationCandidate({ ...shared, policy: deps.earlyAcceleration });
            break;
          case 'CATALYST_RESPONSE':
            decision = detectCatalystCandidate({ ...shared, policy: deps.catalyst, events });
            break;
          case 'SMART_MONEY_ACCUMULATION':
            decision = flow ? detectSmartMoneyCandidate({ ...shared, policy: deps.smartMoney, flow }) : { kind: 'SKIP', reason: 'NO_TRIGGER', detail: 'no tracked-wallet flow' };
            break;
          case 'HOLDER_LIQUIDITY_EXPANSION':
            // S4 hybrid: the families detected earlier this tick count as aligned signals too.
            decision = detectHybridCandidate({ ...shared, policy: deps.hybrid, signals: [...familySignals, ...raisedSignals] });
            break;
        }
        if (decision.kind === 'SKIP') {
          report.skipped[decision.reason]++;
          continue;
        }
        await deps.repo.insertCandidate(decision.candidate);
        if (decision.kind === 'CANDIDATE') {
          report.detected++;
          report.byFamily[family].detected++;
          raisedThisCycle = [...raisedThisCycle, { dedupeKey: decision.candidate.dedupeKey, discoveredAt: decision.candidate.discoveredAt }];
          if (family !== 'HOLDER_LIQUIDITY_EXPANSION') raisedSignals.push({ family, firedAt: decision.candidate.discoveredAt, score: decision.candidate.scannerScore });
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
