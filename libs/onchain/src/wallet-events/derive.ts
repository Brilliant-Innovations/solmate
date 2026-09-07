import { sha256Hex, type Amount, type ChainMovement, type ChainTransactionFacts, type Instant, type MintAddress, type SolanaAddress, type Uuid, type WalletEvent, type WalletEventSource } from '@sol-agent-trader/contracts';

/**
 * Tracked-wallet event derivation (blueprint §3.2, §6.7, §9.3; D8, D26). Pure and deterministic:
 * the same transaction always yields the same events for the same wallet. Rules:
 *  - an OWNED wallet yields nothing (INV-11): our own trades are never smart-money evidence;
 *  - a failed transaction yields nothing: balances did not move;
 *  - a non-quote asset received while a quote asset (settlement stablecoin or SOL) left is a BUY;
 *    the mirror image is a SELL; everything else is a plain transfer.
 * `firstSeenAt` is the ingestion instant the caller supplies, never the block time (D8).
 */

export const DEFAULT_QUOTE_MINTS: readonly MintAddress[] = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wrapped SOL
] as MintAddress[];

export interface DeriveOptions {
  wallet: SolanaAddress;
  isOwned: (address: string) => boolean;
  quoteMints?: readonly MintAddress[];
  source: WalletEventSource;
  now: Instant;
  newId: () => Uuid;
}

interface Flow {
  movement: ChainMovement;
  mint: MintAddress | null;
  amount: bigint;
  direction: 'IN' | 'OUT';
  counterparty: SolanaAddress | null;
}

function flowsFor(tx: ChainTransactionFacts, wallet: SolanaAddress): Flow[] {
  const flows: Flow[] = [];
  for (const m of tx.movements) {
    const inbound = m.toOwner === wallet;
    const outbound = m.fromOwner === wallet;
    if (inbound === outbound) continue; // neither side, or a self-transfer between own accounts
    flows.push({ movement: m, mint: m.mint, amount: BigInt(m.amount), direction: inbound ? 'IN' : 'OUT', counterparty: inbound ? m.fromOwner : m.toOwner });
  }
  return flows;
}

const sum = (flows: Flow[]): bigint => flows.reduce((s, f) => s + f.amount, 0n);

export async function deriveWalletEvents(tx: ChainTransactionFacts, opts: DeriveOptions): Promise<WalletEvent[]> {
  if (opts.isOwned(opts.wallet) || tx.failed) return [];
  const quotes = new Set<string>(opts.quoteMints ?? DEFAULT_QUOTE_MINTS);
  const isQuote = (mint: MintAddress | null) => mint === null || quotes.has(mint);
  const flows = flowsFor(tx, opts.wallet);
  if (flows.length === 0) return [];
  const payloadHash = await sha256Hex(JSON.stringify({ signature: tx.signature, slot: tx.slot, wallet: opts.wallet, movements: tx.movements.map((m) => [m.index, m.kind, m.mint, m.fromOwner, m.toOwner, m.amount]) }));

  const baseIn = flows.filter((f) => f.direction === 'IN' && !isQuote(f.mint));
  const baseOut = flows.filter((f) => f.direction === 'OUT' && !isQuote(f.mint));
  const quoteIn = flows.filter((f) => f.direction === 'IN' && isQuote(f.mint));
  const quoteOut = flows.filter((f) => f.direction === 'OUT' && isQuote(f.mint));
  const baseMints = new Set([...baseIn, ...baseOut].map((f) => f.mint));

  const common = (f: Flow): Omit<WalletEvent, 'kind' | 'quoteMint' | 'quoteAmount'> => ({
    id: opts.newId(),
    wallet: opts.wallet,
    signature: tx.signature,
    movementIndex: f.movement.index,
    slot: tx.slot,
    blockTime: tx.blockTime,
    mint: f.mint,
    amount: f.amount.toString() as Amount,
    decimals: f.movement.decimals,
    counterparty: f.counterparty,
    source: opts.source,
    firstSeenAt: opts.now,
    payloadHash,
  });

  // One base asset against quote flow: a swap.
  if (baseMints.size === 1) {
    const mint = [...baseMints][0] as MintAddress;
    if (baseIn.length > 0 && baseOut.length === 0 && quoteOut.length > 0) {
      const q = quoteOut[0]!;
      const f = baseIn[0]!;
      return [{ ...common(f), amount: sum(baseIn).toString() as Amount, mint, kind: 'BUY', quoteMint: q.mint, quoteAmount: sum(quoteOut.filter((x) => x.mint === q.mint)).toString() as Amount }];
    }
    if (baseOut.length > 0 && baseIn.length === 0 && quoteIn.length > 0) {
      const q = quoteIn[0]!;
      const f = baseOut[0]!;
      return [{ ...common(f), amount: sum(baseOut).toString() as Amount, mint, kind: 'SELL', quoteMint: q.mint, quoteAmount: sum(quoteIn.filter((x) => x.mint === q.mint)).toString() as Amount }];
    }
  }

  // Otherwise every flow is a transfer in its own right.
  return flows.map((f) => ({
    ...common(f),
    kind: f.mint === null ? (f.direction === 'IN' ? 'SOL_IN' : 'SOL_OUT') : f.direction === 'IN' ? 'TRANSFER_IN' : 'TRANSFER_OUT',
    quoteMint: null,
    quoteAmount: null,
  }));
}
