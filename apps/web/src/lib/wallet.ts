import { DEFAULT_WALLET_RESERVE_POLICY } from '@sol-agent-trader/contracts';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Read models for Wallet / Custody (blueprint §20.9, §13.6, D9, D26, D35; plan M8a). Everything
 * shown here is what chain reconciliation observed and what the ledger expected; the browser never
 * holds a signer and the page never reports a balance it did not see (§20.21: missing stays
 * missing, never zero). Funding is manual by construction (§31); this page only shows its record.
 */

export interface AccountView {
  id: string;
  name: string;
  cluster: string;
  trading_wallet: string;
  settlement_mint: string;
}

export interface BalanceLineView {
  address: string;
  mint: string | null;
  expected: string | null;
  observed: string | null;
  delta: string | null;
  ok: boolean;
}

export interface ReconciliationView {
  id: string;
  evaluated_at: string;
  chain_slot: number | null;
  status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE';
  reasons: string[];
  balances: BalanceLineView[];
  unexpected_token_accounts: { tokenAccount: string; mint: string; amount: string; registered: boolean }[];
  unparsed_signatures: string[];
  movement_source: string;
  pause_triggered: boolean;
}

export interface CustodyAccountView {
  id: string;
  kind: string;
  address: string;
  owner_provider: string;
  mint: string | null;
  verification_state: string;
  active_from: string;
  active_to: string | null;
}

export interface EntryPauseView {
  id: string;
  reason: string;
  set_by: string;
  set_by_ref: string;
  set_at: string;
}

export interface FundingEventView {
  id: string;
  state: string;
  source_wallet: string;
  funding_mint: string;
  requested_amount: string;
  tx_signature: string | null;
  created_at: string;
  confirmed_at: string | null;
  failure_reason: string | null;
}

export interface CapitalAttestationView {
  ceiling_usd: number;
  recognized_usd_at_attestation: number | null;
  attested_at: string;
}

export interface WalletView {
  account: AccountView | null;
  reconciliation: ReconciliationView | null;
  custody: CustodyAccountView[];
  pauses: EntryPauseView[];
  funding: FundingEventView[];
  attestation: CapitalAttestationView | null;
  ownedAddresses: number | null;
}

/** The most recent account, paper or live; the page labels which one it is showing (§20.1: PAPER and LIVE never look alike). */
export async function loadWalletView(): Promise<WalletView> {
  const empty: WalletView = { account: null, reconciliation: null, custody: [], pauses: [], funding: [], attestation: null, ownedAddresses: null };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return empty;
  const acc = await supabase.schema('trading').from('accounts').select('id, name, cluster, trading_wallet, settlement_mint').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const account = (acc.data as AccountView | null) ?? null;
  if (!account) return empty;
  const [recon, custody, pauses, funding, attestation, owned] = await Promise.all([
    supabase.schema('trading').from('custody_reconciliations').select('id, evaluated_at, chain_slot, status, reasons, balances, unexpected_token_accounts, unparsed_signatures, movement_source, pause_triggered').eq('account_id', account.id).order('evaluated_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('trading').from('custody_accounts').select('id, kind, address, owner_provider, mint, verification_state, active_from, active_to').eq('account_id', account.id).order('active_from', { ascending: true }),
    supabase.schema('ops').from('entry_pauses').select('id, reason, set_by, set_by_ref, set_at').is('cleared_at', null).order('set_at', { ascending: false }),
    supabase.schema('ops').from('wallet_funding_events').select('id, state, source_wallet, funding_mint, requested_amount, tx_signature, created_at, confirmed_at, failure_reason').eq('destination_trading_wallet', account.trading_wallet).order('created_at', { ascending: false }).limit(20),
    supabase.schema('ops').from('capital_attestations').select('ceiling_usd, recognized_usd_at_attestation, attested_at').eq('account_id', account.id).order('attested_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('intelligence').from('owned_addresses').select('address', { count: 'exact', head: true }),
  ]);
  return {
    account,
    reconciliation: (recon.data as unknown as ReconciliationView | null) ?? null,
    custody: (custody.data as unknown as CustodyAccountView[] | null) ?? [],
    pauses: (pauses.data as unknown as EntryPauseView[] | null) ?? [],
    funding: (funding.data as unknown as FundingEventView[] | null) ?? [],
    attestation: (attestation.data as CapitalAttestationView | null) ?? null,
    ownedAddresses: owned.error ? null : (owned.count ?? null),
  };
}

export type ReserveState = 'OK' | 'BELOW_RESERVE' | 'NO_OBSERVATION';

/** D35 reserve check from what reconciliation actually observed; SOL is the line without a mint. */
export function reserveStatus(reconciliation: ReconciliationView | null, settlementMint: string): { gas: { state: ReserveState; observed: string | null; min: string }; settlement: { state: ReserveState; observed: string | null; min: string } } {
  const policy = DEFAULT_WALLET_RESERVE_POLICY;
  const line = (pred: (b: BalanceLineView) => boolean) => reconciliation?.balances.find(pred) ?? null;
  const check = (observed: string | null, min: string): ReserveState => (observed === null ? 'NO_OBSERVATION' : BigInt(observed) < BigInt(min) ? 'BELOW_RESERVE' : 'OK');
  const sol = line((b) => b.mint === null)?.observed ?? null;
  const settlement = line((b) => b.mint === settlementMint)?.observed ?? null;
  return {
    gas: { state: check(sol, policy.minGasLamports), observed: sol, min: policy.minGasLamports },
    settlement: { state: check(settlement, policy.minSettlementBaseUnits), observed: settlement, min: policy.minSettlementBaseUnits },
  };
}

export const lamportsToSol = (lamports: string | null): string => (lamports === null ? '—' : (Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }));
export const short = (address: string): string => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);
