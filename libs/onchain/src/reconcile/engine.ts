import type {
  Amount,
  BalanceLine,
  ChainTransactionFacts,
  ClassifiedMovement,
  CustodyBalanceObservation,
  CustodyKind,
  CustodyReconciliation,
  Instant,
  MintAddress,
  ReconciliationPolicy,
  ReconciliationReason,
  SignedAmount,
  Slot,
  SolanaAddress,
  TxSignature,
  Uuid,
} from '@sol-agent-trader/contracts';

/**
 * Pure chain/custody reconciliation (blueprint D9, §6.17, §13.6). Chain balances are authoritative;
 * the ledger (open positions) is the expectation; parsed movements only explain deltas. Anything
 * unexplained — a token balance that disagrees with the ledger, a token account the ledger does not
 * know, an unregistered custody location, a movement no authorized lifecycle claims, or a
 * transaction we could not parse — is a MISMATCH and pauses new entries. A failed chain read is
 * UNAVAILABLE: not clean, not a pause.
 */

export interface CustodyView {
  id: Uuid | null;
  address: SolanaAddress;
  kind: CustodyKind;
  mint: MintAddress | null;
  active: boolean;
}

export interface LedgerExpectation {
  mint: MintAddress;
  expected: Amount;
}

export interface ReconcileInput {
  id: Uuid;
  accountId: Uuid;
  tradingWallet: SolanaAddress;
  settlementMint: MintAddress;
  custody: readonly CustodyView[];
  expectations: readonly LedgerExpectation[];
  /** Null when the chain read failed. */
  observed: readonly CustodyBalanceObservation[] | null;
  chainSlot: Slot | null;
  previousCursor: { lastSignature: TxSignature | null; lastSlot: Slot | null; solLamports: Amount | null } | null;
  /** Signatures touching the wallet since the cursor, oldest first. */
  newSignatures: readonly { signature: TxSignature; slot: Slot }[];
  /** More signatures exist than the policy allows per cycle; nothing was processed. */
  signatureBacklog: boolean;
  /** Parsed facts for the new signatures (subset when some failed to parse). */
  transactions: readonly ChainTransactionFacts[];
  unparsedSignatures: readonly TxSignature[];
  movements: readonly ClassifiedMovement[];
  movementSource: 'HELIUS' | 'NONE';
  now: Instant;
  policy: ReconciliationPolicy;
}

const big = (a: Amount | string): bigint => BigInt(a);
const signed = (v: bigint): SignedAmount => v.toString() as SignedAmount;
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** Expected lamport change of `wallet` from one transaction: provider balance change when present, else transfers and fee. */
export function walletLamportDelta(tx: ChainTransactionFacts, wallet: SolanaAddress): bigint {
  const reported = tx.nativeBalanceChanges.find((c) => c.account === wallet);
  if (reported) return big(reported.lamports);
  let delta = 0n;
  if (tx.feePayer === wallet) delta -= big(tx.feeLamports);
  if (!tx.failed) {
    for (const m of tx.movements) {
      if (m.kind !== 'SOL') continue;
      if (m.toOwner === wallet) delta += big(m.amount);
      if (m.fromOwner === wallet) delta -= big(m.amount);
    }
  }
  return delta;
}

export function reconcileCustody(input: ReconcileInput): CustodyReconciliation {
  const reasons = new Set<ReconciliationReason>();
  const balances: BalanceLine[] = [];
  const unexpectedTokenAccounts: CustodyReconciliation['unexpectedTokenAccounts'] = [];
  const custodyByAddress = new Map(input.custody.filter((c) => c.active).map((c) => [c.address, c]));
  const walletCustodyId = custodyByAddress.get(input.tradingWallet)?.id ?? null;
  const prev = input.previousCursor;
  const base = {
    id: input.id,
    accountId: input.accountId,
    evaluatedAt: input.now,
    policyVersion: input.policy.version,
    chainSlot: input.chainSlot,
    movementSource: input.movementSource,
    unparsedSignatures: [...input.unparsedSignatures],
    movements: [...input.movements],
    unexpectedTokenAccounts,
    balances,
  };

  if (input.observed === null) {
    return {
      ...base,
      status: 'UNAVAILABLE',
      reasons: ['CHAIN_READ_FAILED'],
      cursor: { lastSignature: prev?.lastSignature ?? null, lastSlot: prev?.lastSlot ?? null, solLamports: prev?.solLamports ?? null },
      pauseTriggered: false,
    };
  }

  // Token balances versus the ledger, aggregated per mint over every token account the wallet owns.
  const tokenObs = input.observed.filter((o) => o.mint !== null && o.owner === input.tradingWallet);
  const expectedMints = new Set(input.expectations.map((e) => e.mint));
  for (const e of input.expectations) {
    const observed = tokenObs.filter((o) => o.mint === e.mint).reduce((s, o) => s + big(o.amount), 0n);
    const delta = observed - big(e.expected);
    const ok = abs(delta) <= BigInt(input.policy.tokenToleranceBaseUnits);
    if (!ok) reasons.add('BALANCE_MISMATCH');
    const acct = tokenObs.find((o) => o.mint === e.mint);
    balances.push({ custodyAccountId: acct ? (custodyByAddress.get(acct.address)?.id ?? null) : null, address: acct?.address ?? input.tradingWallet, mint: e.mint, expected: e.expected, observed: observed.toString() as Amount, delta: signed(delta), ok });
  }
  // Settlement cash has no ledger expectation until the cash ledger exists (M5a): observed only.
  const settlement = tokenObs.filter((o) => o.mint === input.settlementMint).reduce((s, o) => s + big(o.amount), 0n);
  balances.push({ custodyAccountId: null, address: tokenObs.find((o) => o.mint === input.settlementMint)?.address ?? input.tradingWallet, mint: input.settlementMint, expected: null, observed: settlement.toString() as Amount, delta: null, ok: true });

  // Token accounts the ledger does not know, and custody locations nobody registered.
  for (const o of tokenObs) {
    const empty = big(o.amount) === 0n;
    if (empty && input.policy.ignoreEmptyTokenAccounts) continue;
    const registered = custodyByAddress.has(o.address);
    const mint = o.mint as MintAddress;
    if (!expectedMints.has(mint) && mint !== input.settlementMint) {
      reasons.add('UNEXPECTED_TOKEN_ACCOUNT');
      unexpectedTokenAccounts.push({ tokenAccount: o.address, mint, amount: o.amount, registered });
    }
    if (!registered) reasons.add('UNREGISTERED_CUSTODY_LOCATION');
  }

  // Movements: anything the custody classifier could not tie to an authorized lifecycle.
  for (const m of input.movements) if (m.classification === 'UNKNOWN' && !m.failed) reasons.add('UNKNOWN_MOVEMENT');
  if (input.unparsedSignatures.length > 0) reasons.add('MOVEMENT_UNPARSEABLE');
  if (input.signatureBacklog) reasons.add('SIGNATURE_BACKLOG');

  // SOL: expectation is the previous observation plus every parsed transaction's effect on the wallet.
  const solObs = input.observed.find((o) => o.mint === null && o.address === input.tradingWallet);
  const observedSol = solObs ? big(solObs.amount) : null;
  let expectedSol: bigint | null = null;
  const solAccountable = prev?.solLamports != null && !input.signatureBacklog && input.unparsedSignatures.length === 0;
  if (solAccountable && prev?.solLamports != null) {
    expectedSol = input.transactions.reduce((s, tx) => s + walletLamportDelta(tx, input.tradingWallet), big(prev.solLamports));
  }
  let solOk = true;
  if (expectedSol !== null && observedSol !== null) {
    solOk = abs(observedSol - expectedSol) <= BigInt(input.policy.solToleranceLamports);
    if (!solOk) reasons.add('SOL_BALANCE_MISMATCH');
  }
  balances.unshift({
    custodyAccountId: walletCustodyId,
    address: input.tradingWallet,
    mint: null,
    expected: expectedSol === null ? null : (expectedSol.toString() as Amount),
    observed: observedSol === null ? null : (observedSol.toString() as Amount),
    delta: expectedSol !== null && observedSol !== null ? signed(observedSol - expectedSol) : null,
    ok: solOk,
  });

  const status = reasons.size === 0 ? 'CLEAN' : 'MISMATCH';
  const newest = input.signatureBacklog ? null : input.newSignatures[input.newSignatures.length - 1];
  return {
    ...base,
    status,
    reasons: [...reasons],
    cursor: {
      lastSignature: newest?.signature ?? prev?.lastSignature ?? null,
      lastSlot: newest?.slot ?? prev?.lastSlot ?? null,
      // Re-baseline on every accounted cycle; carry the previous baseline through a backlog.
      solLamports: input.signatureBacklog ? (prev?.solLamports ?? null) : observedSol === null ? (prev?.solLamports ?? null) : (observedSol.toString() as Amount),
    },
    pauseTriggered: status === 'MISMATCH',
  };
}
