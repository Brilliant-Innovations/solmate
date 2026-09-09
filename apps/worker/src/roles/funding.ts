import { FundingRequestPayload, NATIVE_SOL_MINT, validateFundingTransfer, type Clock, type ControlRequestKind, type Instant, type SolanaCluster, type TxSignature, type Uuid, type WalletFundingEvent } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `funding` (blueprint §20.18, §6.16A, D56). Records what the operator's own Wallet
 * Standard wallet did with a reviewed funding transfer: SUBMITTED (with the signature the wallet
 * reported), FAILED or ABANDONED. The typed guard runs again here against the trading account the
 * destination names, so a browser that was tricked into a different destination, mint or cluster
 * records nothing. Confirmation never comes from this role: reconciliation matches the signature
 * to chain deltas (funding.spec + reconciliation role) and only then moves the event to CONFIRMED.
 */

export interface FundingRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  /** The trading account whose wallet the transfer names, with its settlement ATA when registered. */
  accountByTradingWallet(wallet: string): Promise<{ id: Uuid; cluster: SolanaCluster; tradingWallet: string; settlementMint: string; settlementAta: string | null } | null>;
  insertFundingEvent(e: WalletFundingEvent): Promise<void>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
}

export interface FundingDeps {
  repo: FundingRepo;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number };
  newId?: () => Uuid;
}

export interface FundingReport {
  requests: number;
  recorded: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

export async function runFundingCycle(deps: FundingDeps): Promise<FundingReport> {
  const now = deps.clock.now();
  const report: FundingReport = { requests: 0, recorded: 0, refused: {}, errors: [] };
  const requests = await deps.repo.listPending(['FUND_TRADING_WALLET'], deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('funding_refused', { requestId: req.id, reason, by: req.requestedBy, ...extra });
    };
    try {
      const role = await deps.repo.operatorRole(req.requestedBy);
      if (role !== 'operator' && role !== 'admin') {
        await refuse('NOT_AN_OPERATOR', { role });
        continue;
      }
      const parsed = FundingRequestPayload.safeParse(req.payload);
      if (!parsed.success) {
        await refuse('MALFORMED_PAYLOAD', { detail: parsed.error.issues.map((i) => i.path.join('.') || i.message).slice(0, 3).join(', ') });
        continue;
      }
      const { transfer, outcome, txSignature, failureReason } = parsed.data;
      const account = await deps.repo.accountByTradingWallet(transfer.destinationTradingWallet);
      if (!account) {
        await refuse('UNKNOWN_DESTINATION');
        continue;
      }
      const guard = validateFundingTransfer(transfer, { tradingWallet: account.tradingWallet, settlementMint: account.settlementMint, cluster: account.cluster, settlementAta: account.settlementAta });
      if (!guard.ok) {
        await refuse('FUNDING_GUARD', { reasons: guard.reasons });
        continue;
      }
      if (outcome === 'SUBMITTED' && !txSignature) {
        await refuse('MALFORMED_PAYLOAD', { detail: 'SUBMITTED needs the signature the wallet reported' });
        continue;
      }
      const id = deps.newId?.() ?? (crypto.randomUUID() as Uuid);
      await deps.repo.insertFundingEvent({
        id,
        operatorUserId: req.requestedBy,
        sourceWallet: transfer.sourceWallet,
        destinationTradingWallet: transfer.destinationTradingWallet,
        destinationAta: transfer.destinationAta,
        fundingMint: transfer.fundingMint,
        requestedAmount: transfer.requestedAmount,
        cluster: transfer.cluster,
        state: outcome,
        txSignature: outcome === 'SUBMITTED' ? (txSignature as TxSignature) : null,
        confirmedDeltas: null,
        createdAt: now,
        submittedAt: outcome === 'SUBMITTED' ? now : null,
        confirmedAt: null,
        failureReason: outcome === 'SUBMITTED' ? null : (failureReason ?? outcome),
      });
      report.recorded++;
      await deps.repo.resolve(req.id, 'ACCEPTED', { fundingEventId: id, state: outcome, native: transfer.fundingMint === NATIVE_SOL_MINT }, now);
      deps.logger.info('funding_recorded', { requestId: req.id, fundingEventId: id, state: outcome, accountId: account.id, mint: transfer.fundingMint, amount: transfer.requestedAmount, by: req.requestedBy });
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
      deps.logger.error('funding_failed', { requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
