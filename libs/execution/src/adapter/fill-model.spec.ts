import fc from 'fast-check';
import { addMs, DEFAULT_PAPER_FILL_POLICY, toInstant, type Bps, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import { impliedPrice, modelPaperFill } from './fill-model.js';
import { baseIntent, quoteOf } from './parity.js';

const AT = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const ID = '11111111-1111-4111-8111-111111111111' as Uuid;
const intent = baseIntent(ID, 'parity:intent:1', USDC, TOKEN, AT, addMs(AT, 60_000));
const EXEC_AT = addMs(AT, DEFAULT_PAPER_FILL_POLICY.submissionDelayMs);

describe('paper fill model (§17.1–17.4, D48)', () => {
  it('derives the fill from the executable quote with the path allowance applied once, and measures the shortfall against the decision quote', () => {
    const decision = quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
    const executable = quoteOf(100_000_000n, 995_000n, 100, 20, USDC, TOKEN, EXEC_AT);
    const r = modelPaperFill({ intent, decisionQuote: decision, executableQuote: executable, path: 'JUPITER_ORDER', policy: DEFAULT_PAPER_FILL_POLICY, executionAt: EXEC_AT });
    expect(r.kind).toBe('FILL');
    if (r.kind !== 'FILL') return;
    // 995 000 × (1 − 15 bps) = 993 507
    expect(r.outputAmount).toBe('993507');
    expect(r.adverseAllowanceBps).toBe(15);
    // shortfall vs decision 1 000 000: (1 000 000 − 993 507) / 1 000 000 = 64.9 bps → 64 (integer floor)
    expect(r.executionShortfallBps).toBe(64);
    expect(r.fees).toEqual({ networkBaseUnits: '5000', priorityBaseUnits: '20000', routerBaseUnits: '0', transferFeeBaseUnits: '0' });
    const rpc = modelPaperFill({ intent, decisionQuote: decision, executableQuote: executable, path: 'DIRECT_POOL_RPC', policy: DEFAULT_PAPER_FILL_POLICY, executionAt: EXEC_AT });
    expect(rpc.kind === 'FILL' && rpc.outputAmount).toBe('989030');
  });

  it('property: a fill never exceeds the executable expected output, never falls below its minimum, and never depends on the decision quote; below-minimum output does not land', () => {
    const big = fc.bigInt({ min: 1n, max: 10n ** 12n });
    fc.assert(
      fc.property(big, big, big, fc.integer({ min: 1, max: 500 }), fc.constantFrom('JUPITER_ORDER', 'PROVIDER_PROTECTIVE', 'DIRECT_POOL_PRIVATE', 'DIRECT_POOL_RPC'), (decisionOut, execOut, otherDecisionOut, slippage, path) => {
        const wide = { ...intent, constraints: { ...intent.constraints, chaseToleranceBps: 10_000 as Bps, maxSlippageBps: slippage as Bps } };
        const decision = quoteOf(100_000_000n, decisionOut, slippage, 20, USDC, TOKEN, AT);
        const executable = quoteOf(100_000_000n, execOut, slippage, 20, USDC, TOKEN, EXEC_AT);
        const r = modelPaperFill({ intent: wide, decisionQuote: decision, executableQuote: executable, path: path as never, policy: DEFAULT_PAPER_FILL_POLICY, executionAt: EXEC_AT });
        const allowance = DEFAULT_PAPER_FILL_POLICY.adverseAllowanceBpsByPath[path as 'JUPITER_ORDER'];
        const modelled = (execOut * BigInt(10_000 - allowance)) / 10_000n;
        if (modelled < BigInt(executable.minOutputAmount)) {
          expect(r).toMatchObject({ kind: 'REJECT', stage: 'NOT_LANDED', reason: 'SLIPPAGE_EXCEEDED' });
          return;
        }
        expect(r.kind).toBe('FILL');
        if (r.kind !== 'FILL') return;
        expect(BigInt(r.outputAmount) <= execOut).toBe(true);
        expect(BigInt(r.outputAmount) >= BigInt(executable.minOutputAmount)).toBe(true);
        const other = modelPaperFill({ intent: wide, decisionQuote: quoteOf(100_000_000n, otherDecisionOut, slippage, 20, USDC, TOKEN, AT), executableQuote: executable, path: path as never, policy: DEFAULT_PAPER_FILL_POLICY, executionAt: EXEC_AT });
        expect(other.kind === 'FILL' && other.outputAmount).toBe(r.outputAmount);
      }),
    );
  });

  it('refuses in the order live would: expiry, stale decision quote, missing route, impact, then chase', () => {
    const d = quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, AT);
    const x = quoteOf(100_000_000n, 1_000_000n, 100, 20, USDC, TOKEN, EXEC_AT);
    const run = (over: Partial<Parameters<typeof modelPaperFill>[0]>) => modelPaperFill({ intent, decisionQuote: d, executableQuote: x, path: 'JUPITER_ORDER', policy: DEFAULT_PAPER_FILL_POLICY, executionAt: EXEC_AT, ...over });
    expect(run({ executionAt: addMs(AT, 60_000) })).toMatchObject({ kind: 'REJECT', reason: 'INTENT_EXPIRED' });
    expect(run({ decisionQuote: { ...d, quotedAt: addMs(AT, -20_000) } })).toMatchObject({ kind: 'REJECT', reason: 'QUOTE_STALE' });
    expect(run({ executableQuote: null })).toMatchObject({ kind: 'REJECT', reason: 'NO_ROUTE' });
    expect(run({ executableQuote: { ...x, priceImpactBps: 300 as Bps } })).toMatchObject({ kind: 'REJECT', reason: 'IMPACT_ABOVE_MAX' });
    expect(run({ executableQuote: quoteOf(100_000_000n, 900_000n, 100, 20, USDC, TOKEN, EXEC_AT) })).toMatchObject({ kind: 'REJECT', reason: 'CHASE_EXCEEDED' });
    expect(impliedPrice('100000000' as never, 6, '1000000000' as never, 9)).toBeCloseTo(100);
    expect(impliedPrice('100000000' as never, 6, '0' as never, 9)).toBeNull();
  });
});
