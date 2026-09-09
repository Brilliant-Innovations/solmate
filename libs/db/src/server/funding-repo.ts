import type { Instant, SignedAmount, TxSignature, Uuid, WalletFundingEvent } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Manual funding events (§20.18, §6.16A). Written by the worker only: the browser reports what the
 * operator's wallet signed as a control request, the funding role records it here, and the
 * reconciliation role moves it to CONFIRMED from chain deltas. A browser-reported success never
 * updates authoritative balances (§31 "wallet/chain reconciliation is authoritative").
 */

interface Row {
  id: string;
  operator_user_id: string;
  source_wallet: string;
  destination_trading_wallet: string;
  destination_ata: string | null;
  funding_mint: string;
  requested_amount: string;
  cluster: WalletFundingEvent['cluster'];
  state: WalletFundingEvent['state'];
  tx_signature: string | null;
  confirmed_deltas: { source: string; destination: string } | null;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  failure_reason: string | null;
}

const iso = (s: string): Instant => new Date(s).toISOString() as Instant;

function toEvent(r: Row): WalletFundingEvent {
  return {
    id: r.id as Uuid,
    operatorUserId: r.operator_user_id as Uuid,
    sourceWallet: r.source_wallet as WalletFundingEvent['sourceWallet'],
    destinationTradingWallet: r.destination_trading_wallet as WalletFundingEvent['destinationTradingWallet'],
    destinationAta: r.destination_ata as WalletFundingEvent['destinationAta'],
    fundingMint: r.funding_mint as WalletFundingEvent['fundingMint'],
    requestedAmount: r.requested_amount as WalletFundingEvent['requestedAmount'],
    cluster: r.cluster,
    state: r.state,
    txSignature: r.tx_signature as TxSignature | null,
    confirmedDeltas: r.confirmed_deltas ? { source: r.confirmed_deltas.source as SignedAmount, destination: r.confirmed_deltas.destination as SignedAmount } : null,
    createdAt: iso(r.created_at),
    submittedAt: r.submitted_at ? iso(r.submitted_at) : null,
    confirmedAt: r.confirmed_at ? iso(r.confirmed_at) : null,
    failureReason: r.failure_reason,
  };
}

export async function insertFundingEvent(sql: Sql, e: WalletFundingEvent): Promise<void> {
  await sql`
    insert into ops.wallet_funding_events (id, operator_user_id, source_wallet, destination_trading_wallet, destination_ata, funding_mint, requested_amount, cluster, state, tx_signature, created_at, submitted_at, failure_reason)
    values (${e.id}, ${e.operatorUserId}, ${e.sourceWallet}, ${e.destinationTradingWallet}, ${e.destinationAta}, ${e.fundingMint}, ${e.requestedAmount}, ${e.cluster}, ${e.state}, ${e.txSignature}, ${e.createdAt}, ${e.submittedAt}, ${e.failureReason})`;
}

/** The SUBMITTED funding event that claimed this signature, if any. */
export async function fundingEventBySignature(sql: Sql, signature: TxSignature): Promise<WalletFundingEvent | null> {
  // `tx_signature` is not unique (a failed claim and a later good one can share one), so the
  // newest SUBMITTED claim is the one reconciliation is asked about (review 2026-09-09, M-2).
  const [r] = await sql<Row[]>`select * from ops.wallet_funding_events where tx_signature = ${signature} and state = 'SUBMITTED' order by created_at desc limit 1`;
  return r ? toEvent(r) : null;
}

/** Marks a funding event CONFIRMED from the chain deltas reconciliation observed; idempotent. */
export async function confirmFundingEvent(sql: Sql, id: Uuid, deltas: { source: SignedAmount; destination: SignedAmount }, at: Instant): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update ops.wallet_funding_events set state = 'CONFIRMED', confirmed_deltas = ${sql.json(asJson(deltas))}, confirmed_at = ${at}
    where id = ${id} and state = 'SUBMITTED' returning id`;
  return rows.length > 0;
}

export async function listFundingEvents(sql: Sql, tradingWallet: string, limit = 20): Promise<WalletFundingEvent[]> {
  const rows = await sql<Row[]>`select * from ops.wallet_funding_events where destination_trading_wallet = ${tradingWallet} order by created_at desc limit ${limit}`;
  return rows.map(toEvent);
}
