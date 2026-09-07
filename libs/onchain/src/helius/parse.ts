import { z } from 'zod';
import { toInstant, type Amount, type ChainMovement, type ChainTransactionFacts, type MintAddress, type SignedAmount, type Slot, type SolanaAddress, type TxSignature } from '@sol-agent-trader/contracts';

/**
 * Helius Parsed Events → provider-neutral chain facts (blueprint §3.2, D9). The schema is
 * deliberately tolerant (unknown fields pass through) because Helius adds fields without notice;
 * what we consume is pinned: transfers, fee, fee payer, failure. Nothing here is authority —
 * balances are re-read from the chain by the reconciliation engine; parsed transfers only explain
 * how a balance got where it is.
 *
 * Shapes (Parsed Events v1, verified 2026-09-07):
 *   POST /v1/parsed-events/transactions        { transactions: [sig], commitment }
 *   POST /v1/parsed-events/transaction-history { address, limit, afterSignature|beforeSignature, sortOrder, commitment }
 *   result item: { signature, parserStatus: 'OK'|'ERROR', parsed: { slot, blockTime, fee, feePayer, transactionStatus, error,
 *                  nativeTransfers[{fromUserAccount,toUserAccount,amount}], tokenTransfers[{fromUserAccount,toUserAccount,fromTokenAccount,
 *                  toTokenAccount,rawTokenAmount,decimals,mint,tokenStandard}], accountData[{account,nativeBalanceChange,...}], summary{type,description} } }
 * The legacy Enhanced Transactions shape (tokenAmount as a decimal, timestamp, type) is accepted too so recorded webhook payloads replay.
 * Observed live 2026-09-07: v1 items carry slot, blockTime, fee, feePayer, transactionStatus ('OK'|'ERROR', agreeing with the RPC err flag),
 * error, decodedError, nativeTransfers, tokenTransfers, summary, instructions — and no accountData, so SOL deltas come from fee + transfers.
 */

const Addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const NativeTransfer = z.object({ fromUserAccount: Addr.nullable().optional(), toUserAccount: Addr.nullable().optional(), amount: z.number().int().nonnegative() }).loose();
const TokenTransfer = z
  .object({
    fromUserAccount: Addr.nullable().optional(),
    toUserAccount: Addr.nullable().optional(),
    fromTokenAccount: Addr.nullable().optional(),
    toTokenAccount: Addr.nullable().optional(),
    mint: Addr,
    /** Parsed Events: raw integer (number or string). Legacy: absent. */
    rawTokenAmount: z.union([z.number(), z.string(), z.object({ tokenAmount: z.union([z.number(), z.string()]), decimals: z.number().int() }).loose()]).optional(),
    decimals: z.number().int().min(0).max(18).optional(),
    /** Legacy Enhanced Transactions: decimal-scaled amount. */
    tokenAmount: z.number().optional(),
    tokenStandard: z.string().optional(),
  })
  .loose();
const AccountData = z.object({ account: Addr, nativeBalanceChange: z.number().int().optional() }).loose();
const Parsed = z
  .object({
    slot: z.number().int().nonnegative(),
    blockTime: z.number().int().nullable().optional(),
    timestamp: z.number().int().nullable().optional(),
    fee: z.number().int().nonnegative().optional(),
    feePayer: Addr.nullable().optional(),
    transactionStatus: z.string().optional(),
    error: z.unknown().nullable().optional(),
    transactionError: z.unknown().nullable().optional(),
    nativeTransfers: z.array(NativeTransfer).nullable().optional(),
    tokenTransfers: z.array(TokenTransfer).nullable().optional(),
    accountData: z.array(AccountData).nullable().optional(),
    summary: z.object({ type: z.string().nullable().optional(), description: z.string().nullable().optional() }).loose().nullable().optional(),
    type: z.string().optional(),
  })
  .loose();

/** One item of a Parsed Events result, or one legacy enhanced transaction (flat). */
export const HeliusTransactionResult = z.union([
  z.object({ signature: z.string().min(86).max(88), parserStatus: z.string(), parsed: Parsed.nullable().optional() }).loose(),
  Parsed.extend({ signature: z.string().min(86).max(88) }),
]);
export type HeliusTransactionResult = z.infer<typeof HeliusTransactionResult>;
type ParsedTx = z.infer<typeof Parsed>;

export type ParseOutcome = { ok: true; facts: ChainTransactionFacts } | { ok: false; signature: TxSignature; reason: 'PARSER_ERROR' | 'MALFORMED' };

function rawAmount(t: z.infer<typeof TokenTransfer>): { amount: bigint; decimals: number } | null {
  const decimals = t.decimals ?? (typeof t.rawTokenAmount === 'object' && t.rawTokenAmount !== null ? t.rawTokenAmount.decimals : undefined);
  if (t.rawTokenAmount !== undefined && t.rawTokenAmount !== null) {
    const raw = typeof t.rawTokenAmount === 'object' ? t.rawTokenAmount.tokenAmount : t.rawTokenAmount;
    const s = typeof raw === 'number' ? raw.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : raw;
    if (!/^-?\d+$/.test(s) || decimals === undefined) return null;
    const v = BigInt(s);
    const abs = v < 0n ? -v : v;
    if (abs > 18446744073709551615n) return null;
    return { amount: abs, decimals };
  }
  if (t.tokenAmount !== undefined && decimals !== undefined) {
    // Legacy decimal-scaled amount: scale back without floating error by string arithmetic.
    if (!Number.isFinite(t.tokenAmount) || Math.abs(t.tokenAmount) >= 1e21) return null;
    const [int = '0', frac = ''] = Math.abs(t.tokenAmount).toFixed(decimals).split('.');
    const digits = int + frac.padEnd(decimals, '0').slice(0, decimals);
    if (!/^\d+$/.test(digits)) return null;
    return { amount: BigInt(digits), decimals };
  }
  return null;
}

/** Converts one Helius result into chain facts. Failed parses are reported, never guessed. */
export function parseHeliusTransaction(input: unknown): ParseOutcome {
  const res = HeliusTransactionResult.safeParse(input);
  if (!res.success) {
    const sig = typeof input === 'object' && input !== null && typeof (input as { signature?: unknown }).signature === 'string' ? ((input as { signature: string }).signature as TxSignature) : ('' as TxSignature);
    return { ok: false, signature: sig, reason: 'MALFORMED' };
  }
  const item = res.data;
  const signature = item.signature as TxSignature;
  const parsed = (typeof (item as { parserStatus?: unknown }).parserStatus === 'string' ? ((item as { parserStatus: string }).parserStatus === 'OK' ? (item as { parsed?: unknown }).parsed : null) : item) as ParsedTx | null | undefined;
  if (!parsed) return { ok: false, signature, reason: 'PARSER_ERROR' };

  const failed = (parsed.transactionStatus !== undefined && parsed.transactionStatus !== 'OK') || (parsed.error !== undefined && parsed.error !== null) || (parsed.transactionError !== undefined && parsed.transactionError !== null);
  const blockSeconds = parsed.blockTime ?? parsed.timestamp ?? null;
  const blockTime = blockSeconds === null ? null : toInstant(blockSeconds * 1000);
  const summaryType = parsed.summary?.type ?? parsed.type ?? null;
  const movements: ChainMovement[] = [];
  let index = 0;
  for (const n of parsed.nativeTransfers ?? []) {
    movements.push({
      signature, index: index++, slot: parsed.slot as Slot, blockTime, kind: 'SOL', mint: null,
      fromOwner: (n.fromUserAccount ?? null) as SolanaAddress | null, toOwner: (n.toUserAccount ?? null) as SolanaAddress | null, fromTokenAccount: null, toTokenAccount: null,
      amount: String(n.amount) as Amount, decimals: 9, summaryType, failed,
    });
  }
  for (const t of parsed.tokenTransfers ?? []) {
    const amt = rawAmount(t);
    if (!amt) return { ok: false, signature, reason: 'MALFORMED' };
    movements.push({
      signature, index: index++, slot: parsed.slot as Slot, blockTime, kind: 'TOKEN', mint: t.mint as MintAddress,
      fromOwner: (t.fromUserAccount ?? null) as SolanaAddress | null, toOwner: (t.toUserAccount ?? null) as SolanaAddress | null,
      fromTokenAccount: (t.fromTokenAccount ?? null) as SolanaAddress | null, toTokenAccount: (t.toTokenAccount ?? null) as SolanaAddress | null,
      amount: amt.amount.toString() as Amount, decimals: amt.decimals, summaryType, failed,
    });
  }
  return {
    ok: true,
    facts: {
      signature, slot: parsed.slot as Slot, blockTime,
      feeLamports: String(parsed.fee ?? 0) as Amount,
      feePayer: (parsed.feePayer ?? null) as SolanaAddress | null,
      failed,
      nativeBalanceChanges: (parsed.accountData ?? []).filter((a) => a.nativeBalanceChange !== undefined).map((a) => ({ account: a.account as SolanaAddress, lamports: String(a.nativeBalanceChange) as SignedAmount })),
      movements,
    },
  };
}

/** A webhook body (enhanced or parsed-events) is an array of results; each is parsed independently. */
export function parseHeliusWebhookPayload(body: unknown): ParseOutcome[] {
  if (!Array.isArray(body)) return [];
  return body.map(parseHeliusTransaction);
}
