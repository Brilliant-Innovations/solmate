import { randomBytes } from 'node:crypto';
import { deriveAuthorizationHash, instantToMs, type ActionCycle, type AuthorizationDenial, type Bps, type CapitalAuthority, type Clock, type MintAddress, type Nonce, type Proposal, type Release, type ReleaseAttestation, type RiskEvaluation, type RiskPolicy, type Sequence, type Sha256Hex, type SignedRiskAuthorizedIntent, type SignedRiskStateProjection, type SigningKeyPair, type SolanaAddress, type SolanaCluster, type TradeIntent, type Uuid, type VerificationKey, type VersionId } from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import { authorizeEntry, type ClearanceAuditEvidence, type MintHardState } from '../authorize/authorize.js';
import { AuthorizationLedger } from '../authorize/ledger.js';
import type { IndependentChainReads } from '../projection/verify.js';

/**
 * The risk-authorizer service (blueprint §13.7, §15.5, D21, D52; ADR-0009 P1): loads the immutable
 * rows for one cleared cycle, reads chain truth itself, runs `authorizeEntry`, and persists the
 * evaluation, intent and signed envelope. Every source is injected so the same service runs over
 * Postgres and RPC in production and over stubs in tests. The ledger is rebuilt from the stored
 * open authorizations at construction, so a restart cannot sign the same capital twice.
 */

export interface AuthorizerSources {
  cycle(id: Uuid): Promise<ActionCycle | null>;
  proposal(id: Uuid): Promise<Proposal | null>;
  candidateAsset(candidateId: Uuid): Promise<{ asset: { id: Uuid; mint: MintAddress; decimals: number; tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN'; settlementRouteConfirmed: boolean }; eligibility: { id: Uuid; liquidityUsd: number | null } | null; features: Record<string, number | null>; featuresAsOf: string } | null>;
  account(id: Uuid): Promise<{ id: Uuid; cluster: SolanaCluster; tradingWallet: SolanaAddress; settlementMint: MintAddress; settlementDecimals: number | null; mode: 'LIVE' | 'PAPER' } | null>;
  sessionGate(accountId: Uuid): Promise<{ activity: string; paused: boolean; authority: CapitalAuthority } | null>;
  custodyAccounts(accountId: Uuid): Promise<{ id: Uuid; address: SolanaAddress; mint: MintAddress | null }[]>;
  release(strategyVersionId: VersionId): Promise<Release | null>;
  attestation(releaseId: Uuid): Promise<ReleaseAttestation | null>;
  projection(accountId: Uuid): Promise<{ envelope: SignedRiskStateProjection; sequence: Sequence } | null>;
  chain(wallet: SolanaAddress, settlementMint: MintAddress, custody: { id: Uuid; address: SolanaAddress; mint: MintAddress | null }[]): Promise<IndependentChainReads>;
  mint(mint: MintAddress): Promise<MintHardState>;
  /** Reference quote at the policy's maximum size for impact and price; null when no route. */
  referenceQuote(inputMint: MintAddress, outputMint: MintAddress, inputAmount: string, maxSlippageBps: Bps): Promise<{ impactBps: Bps | null; slippageBps: Bps; priceUsd: number | null; quotedAtMs: number } | null>;
  openAuthorizations(): Promise<{ nonce: Nonce; intentId: Uuid; actionCycleId: Uuid; sleeveId: Uuid | null; exposureEffect: TradeIntent['exposureEffect']; maxInputAmount: string; issuedAt: string; expiresAt: string }[]>;
  persistAuthorization(input: { evaluation: RiskEvaluation; intent: TradeIntent; envelope: SignedRiskAuthorizedIntent; authorizationHash: Sha256Hex }): Promise<void>;
  persistDenial(denial: AuthorizationDenial): Promise<void>;
  /** The cycle's clearance row and the ledger's standing against the external checkpoint, read by the authorizer itself (ADR-0009 P2). */
  auditEvidence(cycle: ActionCycle): Promise<ClearanceAuditEvidence>;
}

export interface AuthorizerServiceDeps {
  sources: AuthorizerSources;
  signing: SigningKeyPair;
  projectionKeys: readonly VerificationKey[];
  trustedAttestationFingerprints: readonly Sha256Hex[];
  policy: RiskPolicy;
  clock: Clock;
  logger: Logger;
  newId: () => Uuid;
  config: { projectionMaxAgeMs: number; intentExpiryMs: number; balanceToleranceBps: number; maxSlotLag: number };
}

export type AuthorizeRequestOutcome =
  | { kind: 'AUTHORIZED'; envelope: SignedRiskAuthorizedIntent; authorizationHash: Sha256Hex; intentId: Uuid; projectionSequence: Sequence }
  | { kind: 'DENIED'; denial: AuthorizationDenial };

const ENTRY_ACTIVITY = new Set(['ACTIVE', 'EVENT_WINDOW']);

export class AuthorizerService {
  readonly ledger = new AuthorizationLedger();
  private lastProjectionSequence: Sequence | null = null;

  private constructor(private readonly deps: AuthorizerServiceDeps) {}

  static async create(deps: AuthorizerServiceDeps): Promise<AuthorizerService> {
    const s = new AuthorizerService(deps);
    for (const a of await deps.sources.openAuthorizations()) {
      s.ledger.issue({ nonce: a.nonce, intentId: a.intentId, actionCycleId: a.actionCycleId, sleeveId: a.sleeveId, exposureEffect: a.exposureEffect, maxInputAmount: a.maxInputAmount as never, issuedAt: a.issuedAt as never, expiresAt: a.expiresAt as never, consumedAt: null });
    }
    deps.logger.info('authorizer_ledger_restored', { open: s.ledger.size() });
    return s;
  }

  async authorize(req: { actionCycleId: Uuid; accountId: Uuid }): Promise<AuthorizeRequestOutcome> {
    const { sources } = this.deps;
    const now = this.deps.clock.now();
    const deny = async (reasonCodes: string[], detail: string | null = null): Promise<AuthorizeRequestOutcome> => {
      const denial: AuthorizationDenial = { intentId: null, actionCycleId: req.actionCycleId, deniedAt: now, reasonCodes, detail };
      await sources.persistDenial(denial).catch((err: unknown) => this.deps.logger.error('denial_persist_failed', { error: err instanceof Error ? err.message : String(err) }));
      return { kind: 'DENIED', denial };
    };

    const cycle = await sources.cycle(req.actionCycleId);
    if (!cycle) return deny(['CYCLE_NOT_FOUND']);
    if (!cycle.proposalId || !cycle.candidateId) return deny(['CYCLE_INCOMPLETE']);
    const [proposal, candidate, account] = await Promise.all([sources.proposal(cycle.proposalId), sources.candidateAsset(cycle.candidateId), sources.account(req.accountId)]);
    if (!proposal) return deny(['PROPOSAL_NOT_FOUND']);
    if (!candidate) return deny(['CANDIDATE_NOT_FOUND']);
    if (!account) return deny(['ACCOUNT_NOT_FOUND']);
    if (account.mode !== 'LIVE') return deny(['ACCOUNT_NOT_LIVE'], 'the authorizer signs only for LIVE accounts; paper entries never need an envelope');
    if (account.settlementDecimals === null) return deny(['SETTLEMENT_ASSET_UNKNOWN']);
    const gate = await sources.sessionGate(account.id);
    if (!gate) return deny(['NO_OPEN_SESSION']);
    const capitalAuthority = gate.authority;
    const sessionAllowsEntries = ENTRY_ACTIVITY.has(gate.activity) && !gate.paused;

    const release = await sources.release(cycle.strategyVersionId);
    if (!release) return deny(['RELEASE_NOT_FOUND']);
    const [attestation, projection, custody] = await Promise.all([sources.attestation(release.id), sources.projection(account.id), sources.custodyAccounts(account.id)]);
    if (!projection) return deny(['PROJECTION_NOT_FOUND']);
    const audit = await sources.auditEvidence(cycle);

    // Independent chain reads are the authorizer's own; a read failure denies rather than falls back to the projection (D45, INV-07).
    let chain: IndependentChainReads | null = null;
    let mint: MintHardState | null = null;
    try {
      [chain, mint] = await Promise.all([sources.chain(account.tradingWallet, account.settlementMint, custody), sources.mint(candidate.asset.mint)]);
    } catch (err) {
      return deny(['CHAIN_READ_FAILED'], err instanceof Error ? err.message : String(err));
    }

    const f = candidate.features;
    const num = (n: string) => (typeof f[n] === 'number' ? (f[n] as number) : null);
    const ref = await sources.referenceQuote(account.settlementMint, candidate.asset.mint, this.deps.policy.maxPositionValueBaseUnits, this.deps.policy.maxSlippageBps).catch(() => null);
    const quote = ref && ref.priceUsd !== null ? { ageMs: Math.max(0, instantToMs(now) - ref.quotedAtMs), impactBps: ref.impactBps, slippageBps: ref.slippageBps, priceUsd: ref.priceUsd, atrPct: num('atr_14_pct'), liquidityUsd: num('liquidity_usd') ?? candidate.eligibility?.liquidityUsd ?? null } : null;

    const out = await authorizeEntry({
      now, cycle, proposal,
      asset: { id: candidate.asset.id, mint: candidate.asset.mint, decimals: candidate.asset.decimals, tokenProgram: candidate.asset.tokenProgram, settlementRouteConfirmed: candidate.asset.settlementRouteConfirmed },
      quote, release, attestation, projection: projection.envelope, chain, mint, sessionAllowsEntries, audit,
      account: { id: account.id, cluster: account.cluster, capitalAuthority, settlementDecimals: account.settlementDecimals },
      policy: this.deps.policy,
      keys: { signing: this.deps.signing, projection: this.deps.projectionKeys, trustedAttestationFingerprints: this.deps.trustedAttestationFingerprints },
      ledger: this.ledger,
      lastProjectionSequence: this.lastProjectionSequence,
      config: this.deps.config,
      newNonce: () => randomBytes(16).toString('hex') as Nonce,
      newIntentId: this.deps.newId,
    });
    if (out.kind === 'DENIED') {
      await sources.persistDenial(out.denial).catch((err: unknown) => this.deps.logger.error('denial_persist_failed', { error: err instanceof Error ? err.message : String(err) }));
      this.deps.logger.warn('authorization_denied', { actionCycleId: cycle.id, reasonCodes: out.denial.reasonCodes });
      return { kind: 'DENIED', denial: out.denial };
    }
    this.lastProjectionSequence = out.projectionSequence;
    const p = out.envelope.payload;
    const intent: TradeIntent = {
      id: p.intentId, idempotencyKey: `entry:${cycle.id}` as TradeIntent['idempotencyKey'], accountId: p.accountId, strategyVersionId: p.strategyVersionId, sleeveId: p.sleeveId, assetId: p.assetId, action: p.action, side: p.side, exposureEffect: p.exposureEffect,
      inputMint: p.inputMint, outputMint: p.outputMint, maxInputAmount: p.maxInputAmount, riskEvaluationId: out.evaluation.id, actionCycleId: p.actionCycleId, clearedCutoffVersion: p.clearedCutoffVersion,
      constraints: { maxSlippageBps: p.maxSlippageBps, maxPriceImpactBps: p.maxPriceImpactBps, chaseToleranceBps: p.chaseToleranceBps, maxQuoteAgeMs: p.maxQuoteAgeMs }, protectionPolicyRef: null, targetLotIds: p.targetLotIds, approvalRequired: p.approvalRequired, createdAt: p.issuedAt, expiresAt: p.expiresAt,
    };
    const authorizationHash = await deriveAuthorizationHash(out.envelope);
    await sources.persistAuthorization({ evaluation: out.evaluation, intent, envelope: out.envelope, authorizationHash });
    this.deps.logger.info('authorization_issued', { actionCycleId: cycle.id, intentId: p.intentId, maxInputAmount: p.maxInputAmount, capitalAuthority, projectionSequence: out.projectionSequence });
    return { kind: 'AUTHORIZED', envelope: out.envelope, authorizationHash, intentId: p.intentId, projectionSequence: out.projectionSequence };
  }
}
