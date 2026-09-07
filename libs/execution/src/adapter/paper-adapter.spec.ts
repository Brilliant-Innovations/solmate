import { addMs, DEFAULT_PAPER_FILL_POLICY, fixedClock, toInstant, type ExecutionRequest, type MintAddress, type Order, type OrderAttempt, type SolanaAddress, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import { encodeBase58, PaperExecutionAdapter } from './paper-adapter.js';
import { baseIntent, parityScenarios, quoteOf, runParity, scriptedQuoteClient } from './parity.js';
import { modelPaperFill } from './fill-model.js';

const AT = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const TAKER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as SolanaAddress;
let seq = 0;
const newId = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const request = (intent: TradeIntent): ExecutionRequest => ({ intent, capitalAuthority: 'PAPER', authorization: null, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: AT });

describe('paper execution adapter (§17, M5a)', () => {
  it('passes the paper/live parity table', async () => {
    const report = await runParity(
      (quotes) => new PaperExecutionAdapter({ quotes, clock: fixedClock(AT), policy: DEFAULT_PAPER_FILL_POLICY, taker: TAKER, cluster: 'mainnet-beta', newId, wait: async () => undefined, journal: async () => undefined }),
      parityScenarios(USDC, TOKEN, AT, (ms) => addMs(AT, ms)),
      { intent: () => baseIntent(newId(), `parity:${seq}`, USDC, TOKEN, AT, addMs(AT, 60_000)), request },
    );
    expect(report.filter((r) => r.failures.length)).toEqual([]);
    expect(report).toHaveLength(11);
  });

  it('walks the live attempt sequence with modelled timestamps, journals before submitting, and the fill re-derives from the stored decision quote, executable quote and policy', async () => {
    const quotes = scriptedQuoteClient([quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT), quoteOf(100_000_000n, 995_000n, 100, 20, USDC, TOKEN, AT)]);
    const journaled: { order: Order; attempt: OrderAttempt }[] = [];
    let waited = 0;
    const adapter = new PaperExecutionAdapter({ quotes, clock: fixedClock(AT), policy: DEFAULT_PAPER_FILL_POLICY, taker: TAKER, cluster: 'mainnet-beta', newId, wait: async (ms) => { waited += ms; }, journal: async (r) => { journaled.push(structuredClone(r)); } });
    const intent = baseIntent(newId(), 'parity:detailed', USDC, TOKEN, AT, addMs(AT, 60_000));
    const d = await adapter.executeDetailed(request(intent));
    expect(waited).toBe(DEFAULT_PAPER_FILL_POLICY.submissionDelayMs);
    // the executable quote was requested at the modelled submission moment, after the decision quote
    expect(quotes.calls.map((c) => c.requestedAt)).toEqual([AT, addMs(AT, 1_500)]);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.attempt).toMatchObject({ state: 'SIGNED_NOT_SUBMITTED', submittedAt: null, attemptNumber: 1 });
    expect(journaled[0]!.attempt.signedTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.attempt).toMatchObject({ state: 'FINALIZED', signedAt: addMs(AT, 1_500), submittedAt: addMs(AT, 1_500), confirmedAt: addMs(AT, 2_300), finalizedAt: addMs(AT, 15_300), confirmedSlot: 1000, finalizedSlot: 1032, reconciliationOutcome: 'PAPER_MODELLED' });
    expect(d.attempt.submissions).toEqual([{ at: addMs(AT, 1_500), path: 'JUPITER_ORDER', ok: true, providerResponseSignature: d.attempt.expectedTxSignature, error: null }]);
    expect(d.fill).toMatchObject({ commitment: 'finalized', slot: 1032, inputAmount: '100000000', outputAmount: '993507', executionShortfallBps: 64, executionPath: 'JUPITER_ORDER', filledAt: addMs(AT, 15_300) });
    expect(d.fill!.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    expect(d.result.paper).toMatchObject({ modeledLatencyMs: 15_300, adverseAllowanceBps: 15, modeledOutputAmount: '993507' });
    expect(d.result.paper!.quoteAtDecision.expectedOutputAmount).toBe('1000000');
    // reconstruction from stored inputs
    const again = modelPaperFill({ intent, decisionQuote: d.result.paper!.quoteAtDecision, executableQuote: d.result.quote!, path: 'JUPITER_ORDER', policy: DEFAULT_PAPER_FILL_POLICY, executionAt: d.attempt.submittedAt! });
    expect(again.kind === 'FILL' && again.outputAmount).toBe(d.fill!.outputAmount);
    // identical seed → identical pseudo identifiers (idempotent replays would find the same signature)
    expect(encodeBase58(new Uint8Array([0, 0, 255]))).toBe('115Q');
  });

  it('a not-landed attempt is journaled, submitted and then conclusively dead with the modelled reason; no fill exists', async () => {
    const quotes = scriptedQuoteClient([quoteOf(100_000_000n, 1_000_000n, 5, 20, USDC, TOKEN, AT), quoteOf(100_000_000n, 1_000_000n, 5, 20, USDC, TOKEN, AT)]);
    const adapter = new PaperExecutionAdapter({ quotes, clock: fixedClock(AT), policy: DEFAULT_PAPER_FILL_POLICY, taker: TAKER, cluster: 'mainnet-beta', newId, wait: async () => undefined, journal: async () => undefined });
    const intent = { ...baseIntent(newId(), 'parity:notlanded', USDC, TOKEN, AT, addMs(AT, 60_000)), constraints: { ...baseIntent(newId(), 'x:x:x:x', USDC, TOKEN, AT, AT).constraints, maxSlippageBps: 5 as never } };
    const d = await adapter.executeDetailed(request(intent));
    expect(d.attempt).toMatchObject({ state: 'NOT_LANDED', submittedAt: addMs(AT, 1_500), confirmedAt: null, finalizedAt: null });
    expect(d.attempt.notLandedReason).toMatch(/modelled output .* < minimum/);
    expect(d.fill).toBeNull();
    expect(d.result.rejectionReasons).toEqual(['SLIPPAGE_EXCEEDED']);
    expect(d.result.signedTxHash).not.toBeNull();
  });
});
