import type { Amount, Bps, ExecutionAdapter, ExecutionRequest, Instant, JupiterQuoteClient, MintAddress, OrderAttemptState, Quote, QuoteRequest, QuoteRoutePlan, Slot, TradeIntent, Uuid } from '@sol-agent-trader/contracts';
import { NoRouteError } from '../jupiter/quote-client.js';

/**
 * Paper/live parity suite (execution plan M5a addition, 2026-09-08). A table of scenarios over
 * identical inputs with the outcome any adapter must produce. The paper adapter runs it now; the
 * live adapter (M7) runs the same table over a stubbed transport. Virtual balances and custody
 * are the only permitted differences, so a scenario never asserts on them.
 */

export interface ParityScenario {
  name: string;
  /** Quotes returned in order for successive quote calls; null = NoRouteError. */
  quotes: (Quote | null)[];
  intent: (base: TradeIntent) => TradeIntent;
  request?: (base: ExecutionRequest) => ExecutionRequest;
  expect: { state: OrderAttemptState; rejection: string | null; filled: boolean };
}

export function scriptedQuoteClient(quotes: (Quote | null)[]): JupiterQuoteClient & { calls: QuoteRequest[] } {
  const calls: QuoteRequest[] = [];
  const next = (request: QuoteRequest): { quote: Quote; route: QuoteRoutePlan } => {
    calls.push(request);
    const q = quotes[Math.min(calls.length - 1, quotes.length - 1)];
    if (!q) throw new NoRouteError('SCRIPTED', `${request.inputMint}->${request.outputMint}`);
    // Like the provider: the quote is for the requested amount at the requested slippage (rate scaled linearly).
    const requested = BigInt(request.inputAmount);
    const expected = (BigInt(q.expectedOutputAmount) * requested) / BigInt(q.inputAmount);
    const minOut = (expected * BigInt(10_000 - request.maxSlippageBps)) / 10_000n;
    return { quote: { ...q, inputAmount: request.inputAmount, expectedOutputAmount: expected.toString() as Amount, minOutputAmount: minOut.toString() as Amount, slippageBps: request.maxSlippageBps, quotedAt: request.requestedAt }, route: { hops: [], contextSlot: 1000 as Slot, providerImpactPct: null } };
  };
  return {
    calls,
    quote: async (request) => next(request),
    buildOrder: async (request) => ({ quote: next(request).quote, transactionClass: 'SWAP_V2', unsignedTransactionBase64: null, unsignedTransactionHash: null, feePayer: null, requiredSigners: [] }),
  };
}

export const quoteOf = (inputAmount: bigint, expectedOut: bigint, slippageBps: number, impactBps: number | null, inputMint: MintAddress, outputMint: MintAddress, quotedAt: Instant): Quote => ({
  provider: 'JUPITER',
  providerRequestId: null,
  routerLabel: 'scripted',
  inputMint,
  outputMint,
  inputAmount: inputAmount.toString() as Amount,
  expectedOutputAmount: expectedOut.toString() as Amount,
  minOutputAmount: ((expectedOut * BigInt(10_000 - slippageBps)) / 10_000n).toString() as Amount,
  priceImpactBps: impactBps as Bps | null,
  slippageBps: slippageBps as Bps,
  routeProgramIds: [],
  usesAddressLookupTables: false,
  quotedAt,
  expiresAt: null,
  lastValidBlockHeight: 500,
});

export function parityScenarios(inputMint: MintAddress, outputMint: MintAddress, at: Instant, later: (ms: number) => Instant): ParityScenario[] {
  const q = (out: bigint, impact: number | null = 20, slippage = 100) => quoteOf(100_000_000n, out, slippage, impact, inputMint, outputMint, at);
  return [
    { name: 'clean fill: decision and executable quotes agree, modelled output within the minimum', quotes: [q(1_000_000n), q(1_000_000n)], intent: (b) => b, expect: { state: 'FINALIZED', rejection: null, filled: true } },
    { name: 'price improved between decision and execution: fill with negative shortfall', quotes: [q(1_000_000n), q(1_010_000n)], intent: (b) => b, expect: { state: 'FINALIZED', rejection: null, filled: true } },
    { name: 'intent expired before the modelled submission: refused pre-submit, nothing signed', quotes: [q(1_000_000n), q(1_000_000n)], intent: (b) => ({ ...b, expiresAt: later(500) }), expect: { state: 'PREPARED', rejection: 'INTENT_EXPIRED', filled: false } },
    { name: 'no route at execution time: refused pre-submit', quotes: [q(1_000_000n), null], intent: (b) => b, expect: { state: 'PREPARED', rejection: 'NO_ROUTE', filled: false } },
    { name: 'no route at decision time: refused pre-submit', quotes: [null], intent: (b) => b, expect: { state: 'PREPARED', rejection: 'NO_ROUTE', filled: false } },
    { name: 'executable price moved beyond chase tolerance: refused pre-submit', quotes: [q(1_000_000n), q(980_000n)], intent: (b) => ({ ...b, constraints: { ...b.constraints, chaseToleranceBps: 75 as Bps } }), expect: { state: 'PREPARED', rejection: 'CHASE_EXCEEDED', filled: false } },
    { name: 'executable impact above the cap: refused pre-submit', quotes: [q(1_000_000n), q(1_000_000n, 250)], intent: (b) => b, expect: { state: 'PREPARED', rejection: 'IMPACT_ABOVE_MAX', filled: false } },
    { name: 'unknown executable impact is not a pass: refused pre-submit', quotes: [q(1_000_000n), q(1_000_000n, null)], intent: (b) => b, expect: { state: 'PREPARED', rejection: 'IMPACT_ABOVE_MAX', filled: false } },
    { name: 'tight slippage: the modelled adverse allowance breaches the minimum output, transaction does not land', quotes: [q(1_000_000n, 20, 5), q(1_000_000n, 20, 5)], intent: (b) => ({ ...b, constraints: { ...b.constraints, maxSlippageBps: 5 as Bps } }), expect: { state: 'NOT_LANDED', rejection: 'SLIPPAGE_EXCEEDED', filled: false } },
    { name: 'redelivered intent under the same idempotency key: refused, no second attempt', quotes: [q(1_000_000n), q(1_000_000n)], intent: (b) => b, request: (r) => r, expect: { state: 'PREPARED', rejection: 'DUPLICATE_INTENT', filled: false } },
    { name: 'a live-authority request never executes on the paper adapter', quotes: [q(1_000_000n), q(1_000_000n)], intent: (b) => b, request: (r) => ({ ...r, capitalAuthority: 'LIVE_AUTO' }), expect: { state: 'PREPARED', rejection: 'NOT_PAPER_AUTHORITY', filled: false } },
  ];
}

export function baseIntent(id: Uuid, key: string, inputMint: MintAddress, outputMint: MintAddress, at: Instant, expiresAt: Instant): TradeIntent {
  return {
    id,
    idempotencyKey: key as TradeIntent['idempotencyKey'],
    accountId: id,
    strategyVersionId: 'S0_SAFE@1.0.0' as TradeIntent['strategyVersionId'],
    sleeveId: null,
    assetId: id,
    action: 'ENTER',
    side: 'BUY',
    exposureEffect: 'INCREASE',
    inputMint,
    outputMint,
    maxInputAmount: '100000000' as Amount,
    riskEvaluationId: id,
    actionCycleId: id,
    clearedCutoffVersion: 1,
    constraints: { maxSlippageBps: 100 as Bps, maxPriceImpactBps: 100 as Bps, chaseToleranceBps: 75 as Bps, maxQuoteAgeMs: 15_000 },
    protectionPolicyRef: null,
    targetLotIds: [],
    approvalRequired: false,
    createdAt: at,
    expiresAt,
  };
}

/** Runs the table against an adapter; returns a failure list so both paper and live report the same way. */
export async function runParity(makeAdapter: (quotes: JupiterQuoteClient) => ExecutionAdapter, scenarios: ParityScenario[], make: { intent: () => TradeIntent; request: (intent: TradeIntent) => ExecutionRequest }): Promise<{ name: string; failures: string[] }[]> {
  const report: { name: string; failures: string[] }[] = [];
  for (const s of scenarios) {
    const adapter = makeAdapter(scriptedQuoteClient(s.quotes));
    const intent = s.intent(make.intent());
    const request = s.request ? s.request(make.request(intent)) : make.request(intent);
    let result = await adapter.execute(request);
    if (s.expect.rejection === 'DUPLICATE_INTENT') result = await adapter.execute(request);
    const failures: string[] = [];
    if (result.state !== s.expect.state) failures.push(`state ${result.state} != ${s.expect.state}`);
    const rejection = result.rejectionReasons[0] ?? null;
    if (rejection !== s.expect.rejection) failures.push(`rejection ${rejection} != ${s.expect.rejection}`);
    if ((result.fillId !== null) !== s.expect.filled) failures.push(`filled ${result.fillId !== null} != ${s.expect.filled}`);
    if (s.expect.filled && result.state === 'FINALIZED' && result.txSignature === null) failures.push('finalized without a signature');
    if (!s.expect.filled && s.expect.state === 'PREPARED' && result.signedTxHash !== null) failures.push('pre-submit rejection must not sign');
    report.push({ name: s.name, failures });
  }
  return report;
}
