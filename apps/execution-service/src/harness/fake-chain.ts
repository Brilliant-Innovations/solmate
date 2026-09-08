import { type Amount, type Clock, type JupiterQuoteClient, type MintAddress, type Quote, type QuoteRequest, type QuoteRoutePlan, type Slot, type SigningRequest, type SignatureResult, type TradingWalletSigner } from '@sol-agent-trader/contracts';
import { ASSOCIATED_TOKEN_PROGRAM, BASE_PROGRAMS, COMPUTE_BUDGET_PROGRAM, JUPITER_V6_PROGRAM, JupiterHttpError, NoRouteError, SYSTEM_PROGRAM, TOKEN_PROGRAM, decodeTransaction, encodeTransaction, fromBase64, toBase64, type AccountSnapshot, type ChainObserver, type CustodyReader, type Holding, type DecodedMessage, type JupiterExecuteResult, type JupiterOrder, type JupiterOrderClient, type SignatureStatus, type SimulationOutcome, type SimulationReader } from '@sol-agent-trader/execution';
import { base58Decode, base58Encode } from '@sol-agent-trader/solana-hard-state';
import { CrashSignal, SignerTimeout } from '../pipeline/pipeline.js';

/**
 * Fake Jupiter/Solana for the execution harness (blueprint §24.3). One in-memory chain: wallet
 * balances per mint, a block height that advances, signature statuses that persist once a
 * transaction lands. The router builds the same shape a Swap V2 order does; `/execute` lands
 * or fails according to the scenario, and can die after landing to model a lost response.
 */

export type ExecuteBehaviour =
  | 'FILL'
  | 'FAIL_BEFORE_SUBMIT'
  | 'LAND_THEN_TIMEOUT'
  | 'LAND_THEN_CRASH'
  | 'PARTIAL_FILL'
  | 'STALE_BLOCKHASH'
  | 'SLIPPAGE_FAIL';

export interface FakeChainOptions {
  wallet: string;
  inputMint: MintAddress;
  outputMint: MintAddress;
  clock: Clock;
  quotes: Quote[];
  behaviour: ExecuteBehaviour;
  /** Adverse move applied at landing, in bps of expected output. */
  adverseBps?: number;
  lastValidBlockHeight?: number;
  /** Rewrites the assembled transaction before the executor sees it (tamper scenarios). */
  tamperMessage?: (m: DecodedMessage) => DecodedMessage;
  /** Rewrites the simulated post-state (tamper scenarios). */
  tamperPost?: (post: (AccountSnapshot | null)[], wallet: string) => (AccountSnapshot | null)[];
}

export const IN_ATA = base58Encode(new Uint8Array(32).fill(101));
export const OUT_ATA = base58Encode(new Uint8Array(32).fill(102));
export const OTHER_ATA = base58Encode(new Uint8Array(32).fill(103));
export const OTHER_MINT = base58Encode(new Uint8Array(32).fill(77)) as MintAddress;

export function tokenAccountData(mint: string, owner: string, amount: bigint): string {
  const data = new Uint8Array(165);
  data.set(base58Decode(mint), 0);
  data.set(base58Decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return Buffer.from(data).toString('base64');
}

export function swapMessage(wallet: string): DecodedMessage {
  return {
    version: 0,
    header: { numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 5 },
    staticAccountKeys: [wallet, IN_ATA, OUT_ATA, OTHER_ATA, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, TOKEN_PROGRAM, SYSTEM_PROGRAM],
    recentBlockhash: base58Encode(new Uint8Array(32).fill(9)),
    instructions: [
      { programIdIndex: 4, accountIndexes: [], data: new Uint8Array([2, 64, 66, 15, 0]) },
      { programIdIndex: 5, accountIndexes: [0, 2, 0, 8, 7], data: new Uint8Array([1]) },
      { programIdIndex: 6, accountIndexes: [0, 1, 2, 7], data: new Uint8Array(40).fill(3) },
    ],
    addressTableLookups: [],
  };
}

export class FakeChain implements SimulationReader, ChainObserver, CustodyReader {
  readonly label = 'fake-chain';
  blockHeight_ = 100;
  slot = 1000;
  lamports = 1_000_000_000;
  readonly balances = new Map<string, bigint>();
  readonly statuses = new Map<string, SignatureStatus>();
  readonly landed: { signature: string; inputAmount: bigint; outputAmount: bigint }[] = [];
  readonly executeCalls: string[] = [];
  readonly orders: JupiterOrder[] = [];
  private quoteCalls = 0;
  private ordinal = 0;

  constructor(readonly opts: FakeChainOptions) {
    this.balances.set(opts.inputMint, 1_000_000_000n);
    this.balances.set(opts.outputMint, 0n);
    this.balances.set(OTHER_MINT, 500n);
  }

  advanceBlocks(n: number): void {
    this.blockHeight_ += n;
    this.slot += n;
  }

  finalizeAll(): void {
    for (const s of this.statuses.values()) if (s.err === null) s.confirmationStatus = 'finalized';
  }

  ataFor(mint: string): string {
    return mint === this.opts.inputMint ? IN_ATA : mint === this.opts.outputMint ? OUT_ATA : OTHER_ATA;
  }

  // --- CustodyReader -------------------------------------------------------------------------
  async holdings(owner: string): Promise<{ slot: number; holdings: Holding[] }> {
    if (owner !== this.opts.wallet) return { slot: this.slot, holdings: [] };
    return { slot: this.slot, holdings: [...this.balances.entries()].map(([mint, amount]) => ({ mint: mint as MintAddress, tokenAccount: this.ataFor(mint), amount, frozen: false, program: TOKEN_PROGRAM })) };
  }

  private snapshot(address: string, balances: Map<string, bigint>, lamports: number): AccountSnapshot | null {
    const w = this.opts.wallet;
    if (address === w) return { address, lamports, owner: SYSTEM_PROGRAM, dataBase64: '' };
    if (address === IN_ATA) return { address, lamports: 2_039_280, owner: TOKEN_PROGRAM, dataBase64: tokenAccountData(this.opts.inputMint, w, balances.get(this.opts.inputMint) ?? 0n) };
    if (address === OUT_ATA) return { address, lamports: 2_039_280, owner: TOKEN_PROGRAM, dataBase64: tokenAccountData(this.opts.outputMint, w, balances.get(this.opts.outputMint) ?? 0n) };
    if (address === OTHER_ATA) return { address, lamports: 2_039_280, owner: TOKEN_PROGRAM, dataBase64: tokenAccountData(OTHER_MINT, w, balances.get(OTHER_MINT) ?? 0n) };
    return null;
  }

  // --- SimulationReader ---------------------------------------------------------------------
  async accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: (AccountSnapshot | null)[] }> {
    return { slot: this.slot, accounts: addresses.map((a) => this.snapshot(a, this.balances, this.lamports)) };
  }

  async simulate(_tx: string, addresses: readonly string[]): Promise<SimulationOutcome> {
    const o = this.orders[this.orders.length - 1];
    if (!o) throw new Error('simulate before order');
    const post = new Map(this.balances);
    post.set(o.quote.inputMint, (post.get(o.quote.inputMint) ?? 0n) - BigInt(o.quote.inputAmount));
    post.set(o.quote.outputMint, (post.get(o.quote.outputMint) ?? 0n) + BigInt(o.quote.expectedOutputAmount));
    let accounts = addresses.map((a) => this.snapshot(a, post, this.lamports - 5_000));
    if (this.opts.tamperPost) accounts = this.opts.tamperPost(accounts, this.opts.wallet);
    return { slot: this.slot, err: null, logs: ['Program log: ok'], unitsConsumed: 120_000, accounts };
  }

  // --- ChainObserver -------------------------------------------------------------------------
  async signatureStatus(signature: string): Promise<SignatureStatus | null> {
    return this.statuses.get(signature) ?? null;
  }

  async blockHeight(): Promise<number> {
    return this.blockHeight_;
  }

  // --- Router --------------------------------------------------------------------------------
  quoteClient(): JupiterQuoteClient {
    const next = (request: QuoteRequest): { quote: Quote; route: QuoteRoutePlan } => {
      const q = this.opts.quotes[Math.min(this.quoteCalls++, this.opts.quotes.length - 1)];
      if (!q) throw new NoRouteError('FAKE', 'no route');
      const requested = BigInt(request.inputAmount);
      // The scripted rate applies to its own pair; the reverse pair sells at the inverse rate.
      const reversed = request.inputMint === q.outputMint && request.outputMint === q.inputMint;
      const expected = reversed ? (BigInt(q.inputAmount) * requested) / BigInt(q.expectedOutputAmount) : (BigInt(q.expectedOutputAmount) * requested) / BigInt(q.inputAmount);
      const minOut = (expected * BigInt(10_000 - request.maxSlippageBps)) / 10_000n;
      return { quote: { ...q, inputMint: request.inputMint, outputMint: request.outputMint, inputAmount: request.inputAmount, expectedOutputAmount: expected.toString() as Amount, minOutputAmount: minOut.toString() as Amount, slippageBps: request.maxSlippageBps, quotedAt: request.requestedAt }, route: { hops: [], contextSlot: this.slot as Slot, providerImpactPct: null } };
    };
    return { quote: async (r) => next(r), buildOrder: async (r) => ({ quote: next(r).quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] }) };
  }

  orderClient(): JupiterOrderClient {
    const quotes = this.quoteClient();
    return {
      order: async (request) => {
        const { quote } = await quotes.quote(request);
        let message = swapMessage(this.opts.wallet);
        if (this.opts.tamperMessage) message = this.opts.tamperMessage(message);
        const requestId = `fake-${++this.ordinal}`;
        const o: JupiterOrder = { requestId, quote: { ...quote, providerRequestId: requestId }, transactionBase64: toBase64(encodeTransaction([null], message)), taker: this.opts.wallet, router: 'fake', lastValidBlockHeight: this.opts.lastValidBlockHeight ?? this.blockHeight_ + 150, expiresAt: null };
        this.orders.push(o);
        return o;
      },
      execute: async (signedTransactionBase64, requestId) => this.execute(signedTransactionBase64, requestId),
    };
  }

  private land(signedTransactionBase64: string, outputAmount: bigint): { signature: string; result: JupiterExecuteResult } {
    const tx = decodeTransaction(fromBase64(signedTransactionBase64));
    const signature = tx.signatures[0];
    if (!signature) throw new Error('fake chain: unsigned transaction');
    const o = this.orders[this.orders.length - 1];
    if (!o) throw new Error('fake chain: execute before order');
    const inputAmount = BigInt(o.quote.inputAmount);
    this.balances.set(o.quote.inputMint, (this.balances.get(o.quote.inputMint) ?? 0n) - inputAmount);
    this.balances.set(o.quote.outputMint, (this.balances.get(o.quote.outputMint) ?? 0n) + outputAmount);
    this.lamports -= 5_000;
    this.slot += 1;
    this.statuses.set(signature, { slot: this.slot, confirmationStatus: 'confirmed', err: null });
    this.landed.push({ signature, inputAmount, outputAmount });
    return { signature, result: { status: 'Success', signature, slot: this.slot, code: 0, error: null, inputAmountResult: inputAmount.toString(), outputAmountResult: outputAmount.toString() } };
  }

  private async execute(signedTransactionBase64: string, requestId: string): Promise<JupiterExecuteResult> {
    this.executeCalls.push(requestId);
    const o = this.orders[this.orders.length - 1];
    if (!o) throw new Error('fake chain: execute before order');
    const expected = BigInt(o.quote.expectedOutputAmount);
    const adverse = expected - (expected * BigInt(this.opts.adverseBps ?? 20)) / 10_000n;
    const signature = decodeTransaction(fromBase64(signedTransactionBase64)).signatures[0] ?? null;
    switch (this.opts.behaviour) {
      case 'FAIL_BEFORE_SUBMIT':
        throw new JupiterHttpError(503, 'router unavailable');
      case 'STALE_BLOCKHASH':
        this.advanceBlocks(200);
        return { status: 'Failed', signature, slot: null, code: -32002, error: 'Blockhash not found', inputAmountResult: null, outputAmountResult: null };
      case 'SLIPPAGE_FAIL':
        this.advanceBlocks(200);
        return { status: 'Failed', signature, slot: null, code: 6001, error: 'Slippage tolerance exceeded', inputAmountResult: null, outputAmountResult: null };
      case 'LAND_THEN_TIMEOUT':
        this.land(signedTransactionBase64, adverse);
        throw new JupiterHttpError(504, 'execute timed out');
      case 'LAND_THEN_CRASH':
        this.land(signedTransactionBase64, adverse);
        throw new CrashSignal('AFTER_RESPONSE');
      case 'PARTIAL_FILL':
        return this.land(signedTransactionBase64, (adverse * 6n) / 10n).result;
      case 'FILL':
      default:
        if (adverse < BigInt(o.quote.minOutputAmount)) {
          this.advanceBlocks(200);
          return { status: 'Failed', signature, slot: null, code: 6001, error: 'Slippage tolerance exceeded', inputAmountResult: null, outputAmountResult: null };
        }
        return this.land(signedTransactionBase64, adverse).result;
    }
  }
}

/** A signer that times out `failures` times before answering; the underlying software signer is deterministic. */
export function flakySigner(inner: TradingWalletSigner, failures: number): TradingWalletSigner & { calls: Uint8Array[] } {
  let remaining = failures;
  const calls: Uint8Array[] = [];
  return {
    calls,
    backend: inner.backend,
    publicKey: inner.publicKey,
    health: () => inner.health(),
    async signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult> {
      calls.push(new Uint8Array(messageBytes));
      if (remaining > 0) {
        remaining--;
        throw new SignerTimeout();
      }
      return inner.signTransactionMessage(messageBytes, request);
    },
  };
}

/** A signer-side policy (D55 shape): refuses any message that touches a program outside the allowed set, whatever the executor asked. */
export function policySigner(inner: TradingWalletSigner, allowedPrograms: readonly string[] = [...BASE_PROGRAMS, JUPITER_V6_PROGRAM]): TradingWalletSigner & { refusals: string[] } {
  const refusals: string[] = [];
  return {
    refusals,
    backend: inner.backend,
    publicKey: inner.publicKey,
    health: () => inner.health(),
    async signTransactionMessage(messageBytes: Uint8Array, request: SigningRequest): Promise<SignatureResult> {
      const tx = decodeTransaction(encodeTransaction([null], decodeMessageBytes(messageBytes)));
      for (const ix of tx.message.instructions) {
        const program = tx.message.staticAccountKeys[ix.programIdIndex];
        if (!program || !allowedPrograms.includes(program)) {
          refusals.push(program ?? 'lookup');
          throw new Error(`signer policy: program ${program ?? 'via lookup table'} not allowed`);
        }
      }
      return inner.signTransactionMessage(messageBytes, request);
    },
  };
}

function decodeMessageBytes(messageBytes: Uint8Array): DecodedMessage {
  // A message is a transaction with zero signatures: prefix a zero-length signature vector.
  const bytes = new Uint8Array(messageBytes.length + 1);
  bytes[0] = 0;
  bytes.set(messageBytes, 1);
  return decodeTransaction(bytes).message;
}
