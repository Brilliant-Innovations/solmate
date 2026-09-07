import { randomUUID } from 'node:crypto';
import {
  toInstant,
  type Amount,
  type ChainTransactionFacts,
  type ClassifiedMovement,
  type Clock,
  type CustodyBalanceObservation,
  type CustodyReconciliation,
  type Instant,
  type MintAddress,
  type ReconciliationPolicy,
  type Slot,
  type SolanaAddress,
  type TxSignature,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { classifyMovement, type RegisteredCustody } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { reconcileCustody, type CustodyView, type HeliusClient, type LedgerExpectation } from '@sol-agent-trader/onchain';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import type { CustodyRow, TradingAccountRow } from '@sol-agent-trader/db/server';

/**
 * Worker role `reconciliation` (blueprint D9, §3.2, §6.17, §13.6). For every trading account:
 * read wallet SOL and every token account from the chain (authoritative), list the signatures
 * that touched the wallet since the cursor, parse them through Helius when a key exists, classify
 * each movement against the custody registry and authorized lifecycles, run the pure engine and
 * persist the report — which pauses running sessions on MISMATCH inside the database transaction.
 * The owned-address table is refreshed from the same rows so INV-11 sees the trading wallet and
 * every registered custody location as owned (libs/onchain OwnedAddressRegistry reads it).
 */

export interface ReconciliationRepo {
  listTradingAccounts(): Promise<TradingAccountRow[]>;
  listCustodyAccounts(accountId: Uuid, now: Instant): Promise<CustodyRow[]>;
  ledgerExpectations(accountId: Uuid): Promise<LedgerExpectation[]>;
  reconciliationCursor(accountId: Uuid): Promise<{ lastSignature: TxSignature | null; lastSlot: Slot | null; solLamports: Amount | null } | null>;
  lifecycleForSignature(signature: TxSignature): Promise<{ lifecycleId: Uuid; movementType: RegisteredCustody['allowedMovementTypes'][number] } | null>;
  recordReconciliation(report: CustodyReconciliation): Promise<void>;
  listOwnedAddresses(): Promise<{ address: SolanaAddress }[]>;
  registerOwnedAddress(a: { address: SolanaAddress; purpose: 'TRADING_WALLET' | 'ASSOCIATED_TOKEN_ACCOUNT' | 'JUPITER_TRIGGER_VAULT' | 'OTHER'; cluster: TradingAccountRow['cluster']; accountId: Uuid | null; registeredAt: Instant; retiredAt: Instant | null }): Promise<void>;
}

export interface ReconciliationDeps {
  rpc: SolanaRpcClient;
  helius: HeliusClient | null;
  repo: ReconciliationRepo;
  clock: Clock;
  logger: Logger;
  policy: ReconciliationPolicy;
}

export interface ReconciliationCycleReport {
  accounts: number;
  clean: number;
  mismatch: number;
  unavailable: number;
  paused: number;
  ownedAddresses: number;
  errors: { accountId: Uuid; step: 'CHAIN' | 'SIGNATURES' | 'PARSE' | 'PERSIST'; error: string }[];
}

const CUSTODY_PURPOSE = { TRADING_WALLET: 'TRADING_WALLET', ASSOCIATED_TOKEN_ACCOUNT: 'ASSOCIATED_TOKEN_ACCOUNT', JUPITER_TRIGGER_VAULT: 'JUPITER_TRIGGER_VAULT', APPROVED_OTHER: 'OTHER' } as const;
const MAX_SIGNATURE_PAGES = 5;

async function observeBalances(rpc: SolanaRpcClient, wallet: SolanaAddress): Promise<{ observed: CustodyBalanceObservation[]; slot: Slot }> {
  const sol = await rpc.getBalance(wallet);
  const observed: CustodyBalanceObservation[] = [{ address: wallet, owner: wallet, mint: null, amount: String(sol.value) as Amount, decimals: 9, tokenProgram: null, slot: sol.context.slot as Slot }];
  let slot = sol.context.slot as Slot;
  for (const [programId, tokenProgram] of [
    [TOKEN_PROGRAM_ID, 'TOKEN'],
    [TOKEN_2022_PROGRAM_ID, 'TOKEN_2022'],
  ] as const) {
    const accounts = await rpc.getTokenAccountsByOwner(wallet, programId);
    slot = Math.max(slot, accounts.context.slot) as Slot;
    for (const a of accounts.value) {
      observed.push({ address: a.pubkey as SolanaAddress, owner: a.account.data.parsed.info.owner as SolanaAddress, mint: a.account.data.parsed.info.mint as MintAddress, amount: a.account.data.parsed.info.tokenAmount.amount as Amount, decimals: a.account.data.parsed.info.tokenAmount.decimals, tokenProgram, slot: accounts.context.slot as Slot });
    }
  }
  return { observed, slot };
}

/** Signatures since the cursor, oldest first; `backlog` when more pages exist than we walk. */
async function signaturesSince(rpc: SolanaRpcClient, wallet: SolanaAddress, until: TxSignature | null, pageSize: number): Promise<{ signatures: { signature: TxSignature; slot: Slot }[]; backlog: boolean }> {
  const all: { signature: TxSignature; slot: Slot }[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const batch = await rpc.getSignaturesForAddress(wallet, { until, limit: pageSize, ...(before ? { before } : {}) });
    for (const s of batch) all.push({ signature: s.signature as TxSignature, slot: s.slot as Slot });
    if (batch.length < pageSize) return { signatures: all.reverse(), backlog: false };
    before = batch[batch.length - 1]!.signature;
  }
  return { signatures: [], backlog: true };
}

export async function runReconciliationCycle(deps: ReconciliationDeps): Promise<ReconciliationCycleReport> {
  const report: ReconciliationCycleReport = { accounts: 0, clean: 0, mismatch: 0, unavailable: 0, paused: 0, ownedAddresses: 0, errors: [] };
  const fail = (accountId: Uuid, step: ReconciliationCycleReport['errors'][number]['step'], err: unknown) => report.errors.push({ accountId, step, error: err instanceof Error ? err.message : String(err) });
  const accounts = await deps.repo.listTradingAccounts();
  report.accounts = accounts.length;
  const now = deps.clock.now();
  const owned = new Set((await deps.repo.listOwnedAddresses()).map((o) => o.address as string));

  for (const account of accounts) {
    const custodyRows = await deps.repo.listCustodyAccounts(account.id, now);
    // D26: the trading wallet and every registered custody location are owned, whether or not anyone registered them by hand.
    const toRegister = [{ address: account.tradingWallet, purpose: 'TRADING_WALLET' as const, custodyId: null as Uuid | null }, ...custodyRows.map((c) => ({ address: c.address, purpose: CUSTODY_PURPOSE[c.kind], custodyId: c.id }))];
    for (const r of toRegister) {
      if (owned.has(r.address)) continue;
      await deps.repo.registerOwnedAddress({ address: r.address, purpose: r.purpose, cluster: account.cluster, accountId: account.id, registeredAt: now, retiredAt: null });
      owned.add(r.address);
      report.ownedAddresses++;
    }

    const custody: CustodyView[] = custodyRows.map((c) => ({ id: c.id, address: c.address, kind: c.kind, mint: c.mint, active: c.active }));
    if (!custody.some((c) => c.address === account.tradingWallet)) custody.push({ id: null, address: account.tradingWallet, kind: 'TRADING_WALLET', mint: null, active: true });
    const registry: RegisteredCustody[] = custodyRows.map((c) => ({ id: c.id, address: c.address, mint: c.mint, allowedMovementTypes: c.allowedMovementTypes, active: c.active }));
    const expectations = await deps.repo.ledgerExpectations(account.id);
    const cursor = await deps.repo.reconciliationCursor(account.id);

    let observed: CustodyBalanceObservation[] | null = null;
    let chainSlot: Slot | null = null;
    try {
      const o = await observeBalances(deps.rpc, account.tradingWallet);
      observed = o.observed;
      chainSlot = o.slot;
    } catch (err) {
      fail(account.id, 'CHAIN', err);
    }

    let newSignatures: { signature: TxSignature; slot: Slot }[] = [];
    let backlog = false;
    if (observed) {
      try {
        const s = await signaturesSince(deps.rpc, account.tradingWallet, cursor?.lastSignature ?? null, deps.policy.maxSignaturesPerCycle);
        newSignatures = s.signatures;
        backlog = s.backlog;
      } catch (err) {
        fail(account.id, 'SIGNATURES', err);
        observed = null; // cannot reconcile movements without the signature list: UNAVAILABLE
      }
    }

    const transactions: ChainTransactionFacts[] = [];
    const unparsed: TxSignature[] = [];
    const movements: ClassifiedMovement[] = [];
    if (observed && newSignatures.length > 0) {
      if (!deps.helius) unparsed.push(...newSignatures.map((s) => s.signature));
      else {
        try {
          const outcomes = await deps.helius.parseTransactions(newSignatures.map((s) => s.signature));
          for (const o of outcomes) {
            if (!o.ok) {
              unparsed.push(o.signature);
              continue;
            }
            transactions.push(o.facts);
            const lifecycle = await deps.repo.lifecycleForSignature(o.facts.signature);
            for (const m of o.facts.movements) {
              const from = (m.kind === 'TOKEN' ? (m.fromTokenAccount ?? m.fromOwner) : m.fromOwner) ?? ('' as SolanaAddress);
              const to = (m.kind === 'TOKEN' ? (m.toTokenAccount ?? m.toOwner) : m.toOwner) ?? ('' as SolanaAddress);
              const verdict = classifyMovement(registry, { from, to, mint: (m.mint ?? account.settlementMint) as MintAddress, amount: m.amount, lifecycleId: lifecycle?.lifecycleId ?? null, movementType: lifecycle?.movementType ?? null }, new Set(lifecycle ? [lifecycle.lifecycleId] : []));
              movements.push({ ...m, classification: verdict.kind, reason: verdict.kind === 'UNKNOWN' ? verdict.reason : null, lifecycleId: verdict.kind === 'EXPECTED' ? verdict.lifecycleId : null });
            }
          }
        } catch (err) {
          fail(account.id, 'PARSE', err);
          unparsed.push(...newSignatures.map((s) => s.signature));
        }
      }
    }

    const result = reconcileCustody({
      id: randomUUID() as Uuid,
      accountId: account.id,
      tradingWallet: account.tradingWallet,
      settlementMint: account.settlementMint,
      custody,
      expectations,
      observed,
      chainSlot,
      previousCursor: cursor,
      newSignatures,
      signatureBacklog: backlog,
      transactions,
      unparsedSignatures: unparsed,
      movements,
      movementSource: deps.helius ? 'HELIUS' : 'NONE',
      now: toInstant(deps.clock.nowMs()),
      policy: deps.policy,
    });
    try {
      await deps.repo.recordReconciliation(result);
    } catch (err) {
      fail(account.id, 'PERSIST', err);
      continue;
    }
    if (result.status === 'CLEAN') report.clean++;
    else if (result.status === 'MISMATCH') report.mismatch++;
    else report.unavailable++;
    if (result.pauseTriggered) {
      report.paused++;
      deps.logger.error('custody_reconciliation_mismatch', { accountId: account.id, reasons: result.reasons, unknownMovements: result.movements.filter((m) => m.classification === 'UNKNOWN').length, unparsed: result.unparsedSignatures.length, unexpectedTokenAccounts: result.unexpectedTokenAccounts.length, reconciliationId: result.id });
    }
  }

  deps.logger.info('reconciliation_cycle', { accounts: report.accounts, clean: report.clean, mismatch: report.mismatch, unavailable: report.unavailable, paused: report.paused, ownedAddressesRegistered: report.ownedAddresses, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('reconciliation_step_failed', { accountId: e.accountId, step: e.step, error: e.error });
  return report;
}
