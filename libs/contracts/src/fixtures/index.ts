import type { z } from 'zod';
import { ActionCycle, RuntimeSession, TradeIntent, Release } from '../entities/index.js';
import {
  AdversarialReviewOutput,
  ApprovalGrant,
  EmergencyCommand,
  ExecutorJournalEntry,
  FundTradingWalletRequest,
  PositionRiskShadow,
  QueueMessageEnvelope,
  RiskAuthorizedIntent,
  RiskStateProjection,
  TradingActionProposal,
} from '../envelopes/index.js';

/**
 * Valid, deterministic sample values for the canonical contracts. Used by the cross-boundary
 * encode/decode harness (INV-24) and by every app's contract tests. Fixed ids keep fixtures
 * reproducible; nothing here is a real key, wallet or transaction.
 */

export const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  asset: '22222222-2222-4222-8222-222222222222',
  candidate: '33333333-3333-4333-8333-333333333333',
  position: '44444444-4444-4444-8444-444444444444',
  cycle: '55555555-5555-4555-8555-555555555555',
  intent: '66666666-6666-4666-8666-666666666666',
  release: '77777777-7777-4777-8777-777777777777',
  attestation: '88888888-8888-4888-8888-888888888888',
  sleeve: '99999999-9999-4999-8999-999999999999',
  lot: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operator: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  custody: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  trigger: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  message: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  evaluation: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;

export const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  RISK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
} as const;

export const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const ZERO_HASH = '0'.repeat(64);
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const NONCE = '0123456789abcdef0123456789abcdef';
export const T0 = '2026-09-05T12:00:00.000Z';
export const T1 = '2026-09-05T12:05:00.000Z';

type Of<S extends z.ZodType> = z.output<S>;

export const tradingActionProposal = (): Of<typeof TradingActionProposal> =>
  TradingActionProposal.parse({
    actionType: 'ENTER',
    direction: 'LONG',
    candidateId: IDS.candidate,
    positionId: null,
    strategyVersionId: 'S1@1.0.0',
    skillVersionId: 'skill@1.0.0',
    triggerId: IDS.trigger,
    thesis: 'Relative-volume breakout with confirming on-chain accumulation.',
    supportingEvidenceIds: [IDS.candidate],
    contradictingEvidenceIds: [],
    catalystNovelty: 'confirming',
    expectedHorizonMinutes: 90,
    confidence: 0.72,
    invalidation: 'Loss of 15m VWAP with volume contraction.',
    requestedFractionToReduce: null,
    protectionIntent: null,
    urgency: 'normal',
    expiresAt: T1,
    reasoningSummary: 'Momentum plus flow; no contradicting evidence at cutoff.',
    evidenceCutoffVersion: 1,
  });

export const adversarialReviewOutput = (): Of<typeof AdversarialReviewOutput> =>
  AdversarialReviewOutput.parse({
    verdict: 'CHALLENGE',
    objections: [{ code: 'MOVE_OVEREXTENDED', detail: 'Price is 3.2 ATR above 1h VWAP.', evidenceIds: [IDS.candidate] }],
    counterEvidenceIds: [],
    confidence: 0.61,
    evidenceCutoffVersion: 1,
    reasoningSummary: 'Chase risk exceeds strategy tolerance.',
  });

export const riskStateProjection = (): Of<typeof RiskStateProjection> =>
  RiskStateProjection.parse({
    sequence: 42,
    asOf: T0,
    chainSlot: 300_000_000,
    releaseId: IDS.release,
    releaseDigest: HASH_A,
    policyVersion: 'risk@1.0.0',
    sourceDigests: [{ source: 'custody', digest: HASH_B }],
    settlementMint: MINTS.USDC,
    custody: [{ custodyAccountId: IDS.custody, mint: MINTS.USDC, amount: '5000000000' }],
    settlementAvailableBaseUnits: '5000000000',
    gasReserveLamports: '200000000',
    aggregateNonSettlementExposureBaseUnits: '0',
    exposureUsd: 0,
    signerDependentExposureBaseUnits: '0',
    sleeves: [],
    openLots: [],
    drawdown: { dailyFraction: 0, rollingFraction: 0, circuitBreakerTripped: false, consecutiveLosses: 0 },
    cohortCapacity: [],
    clusterCapacity: [],
    eligibilitySummary: [{ assetId: IDS.asset, evaluationId: IDS.evaluation, eligible: true, evaluatedAt: T0 }],
    freshnessSummary: [{ dataClass: 'market.price', ageMs: 1200, fresh: true }],
    capitalAttestation: { ceilingUsd: 5000, recognizedUsd: 5000, reattestRequired: false },
  });

export const riskAuthorizedIntent = (): Of<typeof RiskAuthorizedIntent> =>
  RiskAuthorizedIntent.parse({
    intentId: IDS.intent,
    intentHash: HASH_B,
    actionCycleId: IDS.cycle,
    clearedCutoffVersion: 1,
    releaseId: IDS.release,
    releaseDigest: HASH_A,
    attestationId: IDS.attestation,
    policyVersion: 'risk@1.0.0',
    policyHash: HASH_A,
    strategyVersionId: 'S0_SAFE@1.0.0',
    sleeveId: IDS.sleeve,
    accountId: IDS.account,
    assetId: IDS.asset,
    cluster: 'mainnet-beta',
    capitalAuthority: 'LIVE_APPROVAL',
    action: 'ENTER',
    side: 'BUY',
    exposureEffect: 'INCREASE',
    inputMint: MINTS.USDC,
    outputMint: MINTS.RISK,
    maxInputAmount: '250000000',
    maxSlippageBps: 100,
    maxPriceImpactBps: 150,
    chaseToleranceBps: 200,
    maxQuoteAgeMs: 5000,
    allowedProtectionMode: 'MONITORED_EXIT',
    targetLotIds: [],
    approvalRequired: true,
    projectionSequence: 42,
    projectionHash: HASH_B,
    issuedAt: T0,
    expiresAt: T1,
    nonce: NONCE,
  });

export const approvalGrant = (): Of<typeof ApprovalGrant> =>
  ApprovalGrant.parse({
    authorizationHash: HASH_A,
    intentId: IDS.intent,
    approverId: IDS.operator,
    role: 'operator',
    stepUpAssertionRef: 'webauthn:assertion:demo',
    grantedAt: T0,
    expiresAt: T1,
    nonce: NONCE,
  });

export const emergencyCommand = (): Of<typeof EmergencyCommand> =>
  EmergencyCommand.parse({
    commandId: IDS.message,
    type: 'EMERGENCY_CLOSE_ASSET',
    cluster: 'mainnet-beta',
    mint: MINTS.RISK,
    maxAmount: null,
    issuer: 'OPERATOR_OUT_OF_BAND',
    reason: 'Provider security alert on held asset.',
    issuedAt: T0,
    expiresAt: T1,
    nonce: NONCE,
  });

export const executorJournalEntry = (): Of<typeof ExecutorJournalEntry> =>
  ExecutorJournalEntry.parse({
    sequence: 7,
    at: T0,
    kind: 'ATTEMPT_SIGNED',
    correlationId: 'corr-1',
    payload: { attemptId: IDS.message, signedTxHash: HASH_A },
    previousHash: ZERO_HASH,
    hash: HASH_B,
  });

export const positionRiskShadow = (): Of<typeof PositionRiskShadow> =>
  PositionRiskShadow.parse({
    sequence: 3,
    asOf: T0,
    settlementMints: [MINTS.SOL, MINTS.USDC],
    positions: [
      {
        positionId: IDS.position,
        assetId: IDS.asset,
        mint: MINTS.RISK,
        lastConfirmedQuantity: '1000000000',
        lots: [{ lotId: IDS.lot, quantity: '1000000000', protectionMode: 'MONITORED_EXIT', providerOrderId: null }],
        stop: { model: 'ATR', level: 0.0012 },
        trailingLevel: null,
        timeStopAt: null,
        unreviewedStop: null,
        primaryRouteSnapshotId: null,
        emergencyRouteSnapshotId: null,
      },
    ],
  });

export const fundTradingWalletRequest = (): Of<typeof FundTradingWalletRequest> =>
  FundTradingWalletRequest.parse({
    fundingIntentId: IDS.message,
    sourceWallet: WALLET,
    destinationTradingWallet: WALLET,
    destinationAta: null,
    fundingMint: MINTS.SOL,
    amount: '1000000000',
    cluster: 'mainnet-beta',
    destinationFingerprint: 'guardrail:trading-wallet:v1',
    createdAt: T0,
    expiresAt: T1,
  });

export const queueMessageEnvelope = (): Of<typeof QueueMessageEnvelope> =>
  QueueMessageEnvelope.parse({
    messageId: IDS.message,
    queue: 'trading-actions',
    kind: 'action_cycle.evaluate',
    kindVersion: 1,
    idempotencyKey: 'cycle:' + IDS.cycle,
    correlationId: 'corr-1',
    causationId: null,
    enqueuedAt: T0,
    attempt: 1,
    contractSetDigest: HASH_A,
    payload: { actionCycleId: IDS.cycle },
  });

export const tradeIntent = (): Of<typeof TradeIntent> =>
  TradeIntent.parse({
    id: IDS.intent,
    idempotencyKey: 'intent:' + IDS.cycle + ':1',
    accountId: IDS.account,
    strategyVersionId: 'S0_SAFE@1.0.0',
    sleeveId: IDS.sleeve,
    assetId: IDS.asset,
    action: 'ENTER',
    side: 'BUY',
    exposureEffect: 'INCREASE',
    inputMint: MINTS.USDC,
    outputMint: MINTS.RISK,
    maxInputAmount: '250000000',
    riskEvaluationId: IDS.evaluation,
    actionCycleId: IDS.cycle,
    clearedCutoffVersion: 1,
    constraints: { maxSlippageBps: 100, maxPriceImpactBps: 150, chaseToleranceBps: 200, maxQuoteAgeMs: 5000 },
    protectionPolicyRef: 'protection@1.0.0',
    targetLotIds: [],
    approvalRequired: true,
    createdAt: T0,
    expiresAt: T1,
  });

export const actionCycle = (): Of<typeof ActionCycle> =>
  ActionCycle.parse({
    id: IDS.cycle,
    automationRunId: null,
    triggerId: IDS.trigger,
    candidateId: IDS.candidate,
    positionId: null,
    strategyVersionId: 'S0_SAFE@1.0.0',
    skillVersionId: null,
    guidelineVersionId: null,
    speedTier: 'T1_MOMENTUM',
    decisionBudgetMs: 120_000,
    proposedAction: 'ENTER',
    proposalId: null,
    proposerRunIds: [],
    adversaryRunIds: [],
    verdict: 'CONFIRM',
    reasonCodes: [],
    revisionRound: 0,
    state: 'CLEARED',
    unresolvedReason: null,
    cutoffs: [{ version: 1, at: T0, consumedByRunIds: [] }],
    clearedCutoffVersion: 1,
    riskEvaluationId: null,
    intentId: null,
    startedAt: T0,
    terminalAt: T1,
  });

export const runtimeSession = (): Of<typeof RuntimeSession> =>
  RuntimeSession.parse({
    id: IDS.message,
    profile: 'P1A',
    activityState: 'ACTIVE',
    capitalAuthority: 'PAPER',
    paused: { active: false, reason: null, since: null, by: null },
    attended: true,
    lastPresenceHeartbeatAt: T0,
    scheduledStartAt: null,
    intendedEndAt: null,
    actualStartAt: T0,
    actualEndAt: null,
    marketSessions: ['US'],
    regime: 'RISK_ON_TREND',
    eventWindow: null,
    coldStartGates: [{ name: 'reconciliation', passed: true, checkedAt: T0, detail: null }],
    exposureAtLastTransition: { managedCount: 0, offlineProtectedCount: 0, unmanagedCount: 0, unmanagedUsd: 0 },
    windDownBlockers: [],
    inFlightExecutionIds: [],
    offlineResumeDeadline: null,
    resumeWatchdog: { expectedCheckAt: null, lastCheckAt: null, status: 'NOT_REQUIRED' },
    transitions: [{ from: 'STARTING', to: 'ACTIVE', at: T0, actor: 'OPERATOR', actorRef: null, reason: null }],
    metadata: {},
  });

export const release = (): Of<typeof Release> =>
  Release.parse({
    id: IDS.release,
    digest: HASH_A,
    binding: {
      strategyVersionId: 'S0_SAFE@1.0.0',
      skillVersionId: null,
      guidelineVersionId: null,
      automationSetVersionId: null,
      proposerModelPolicyVersion: null,
      adversaryModelPolicyVersion: 'adv@1.0.0',
      riskPolicyVersion: 'risk@1.0.0',
      cohortPolicyVersion: 'cohort@1.0.0',
      freshnessPolicyVersion: 'fresh@1.0.0',
      executorPolicyRef: 'exec@1.0.0',
      contractSetDigest: HASH_B,
    },
    status: 'PAPER_VALIDATED',
    createdAt: T0,
    promotedAt: null,
    retiredAt: null,
  });

/** Every fixture paired with its schema, for the roundtrip harness. */
export const fixtureCatalog = (): ReadonlyArray<{ name: string; schema: z.ZodType; value: unknown }> => [
  { name: 'envelopes.TradingActionProposal', schema: TradingActionProposal, value: tradingActionProposal() },
  { name: 'envelopes.AdversarialReviewOutput', schema: AdversarialReviewOutput, value: adversarialReviewOutput() },
  { name: 'envelopes.RiskStateProjection', schema: RiskStateProjection, value: riskStateProjection() },
  { name: 'envelopes.RiskAuthorizedIntent', schema: RiskAuthorizedIntent, value: riskAuthorizedIntent() },
  { name: 'envelopes.ApprovalGrant', schema: ApprovalGrant, value: approvalGrant() },
  { name: 'envelopes.EmergencyCommand', schema: EmergencyCommand, value: emergencyCommand() },
  { name: 'envelopes.ExecutorJournalEntry', schema: ExecutorJournalEntry, value: executorJournalEntry() },
  { name: 'envelopes.PositionRiskShadow', schema: PositionRiskShadow, value: positionRiskShadow() },
  { name: 'envelopes.FundTradingWalletRequest', schema: FundTradingWalletRequest, value: fundTradingWalletRequest() },
  { name: 'envelopes.QueueMessageEnvelope', schema: QueueMessageEnvelope, value: queueMessageEnvelope() },
  { name: 'entities.TradeIntent', schema: TradeIntent, value: tradeIntent() },
  { name: 'entities.ActionCycle', schema: ActionCycle, value: actionCycle() },
  { name: 'entities.RuntimeSession', schema: RuntimeSession, value: runtimeSession() },
  { name: 'entities.Release', schema: Release, value: release() },
];
