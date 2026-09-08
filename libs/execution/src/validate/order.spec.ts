import { addMs, fixtures, sha256Hex, toInstant, type Amount, type Bps, type MintAddress, type RiskAuthorizedIntent } from '@sol-agent-trader/contracts';
import { checkOrderAgainstAuthorization, type JupiterOrderFacts } from './order.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const intent = (): RiskAuthorizedIntent => ({ ...fixtures.riskAuthorizedIntent(), issuedAt: addMs(NOW, -5_000), expiresAt: addMs(NOW, 55_000) });
const bytes = new Uint8Array([1, 2, 3, 4]);

async function order(over: Partial<JupiterOrderFacts> = {}): Promise<JupiterOrderFacts> {
  const i = intent();
  return { requestId: 'req-1', inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.maxInputAmount, outAmount: '1000000' as Amount, minOutAmount: '990000' as Amount, slippageBps: 100 as Bps, priceImpactBps: 20 as Bps, taker: 'wallet', quotedAt: addMs(NOW, -2_000), expiresAt: addMs(NOW, 30_000), lastValidBlockHeight: 1000, transactionBytes: bytes, reportedTransactionHash: await sha256Hex(bytes), ...over };
}

describe('order versus authorization (§15.4 steps 1–3, 7; P7 bounds)', () => {
  it('an order for exactly the authorized pair within amount, slippage, impact, validity and hash passes; a smaller amount is fine', async () => {
    const v = await checkOrderAgainstAuthorization(await order(), intent(), { tradingWallet: 'wallet', now: NOW, currentBlockHeight: 900 });
    expect(v).toEqual({ ok: true, transactionHash: await sha256Hex(bytes) });
    expect((await checkOrderAgainstAuthorization(await order({ inAmount: '1000' as Amount }), intent(), { tradingWallet: 'wallet', now: NOW, currentBlockHeight: 900 })).ok).toBe(true);
  });

  it('every widened or substituted field is refused', async () => {
    const cases: [Partial<JupiterOrderFacts>, { now?: typeof NOW; currentBlockHeight?: number | null; tradingWallet?: string }, string][] = [
      [{ requestId: null }, {}, 'REQUEST_ID_MISSING'],
      [{ inputMint: fixtures.MINTS.RISK as MintAddress }, {}, 'INPUT_MINT_MISMATCH'],
      [{ outputMint: fixtures.MINTS.USDC as MintAddress }, {}, 'OUTPUT_MINT_MISMATCH'],
      [{ inAmount: '250000001' as Amount }, {}, 'AMOUNT_ABOVE_AUTHORIZED'],
      [{ inAmount: '0' as Amount }, {}, 'AMOUNT_ZERO'],
      [{ slippageBps: 101 as Bps }, {}, 'SLIPPAGE_ABOVE_AUTHORIZED'],
      [{ priceImpactBps: 151 as Bps }, {}, 'IMPACT_ABOVE_AUTHORIZED'],
      [{ priceImpactBps: null }, {}, 'IMPACT_UNKNOWN'],
      [{ minOutAmount: '980000' as Amount }, {}, 'MIN_OUT_BELOW_SLIPPAGE_FLOOR'],
      [{ taker: 'attacker' }, {}, 'TAKER_MISMATCH'],
      [{ quotedAt: addMs(NOW, -20_000) }, {}, 'QUOTE_TOO_OLD'],
      [{ expiresAt: NOW }, {}, 'QUOTE_EXPIRED'],
      [{}, { currentBlockHeight: 1001 }, 'BLOCK_HEIGHT_EXPIRED'],
      [{}, { now: addMs(NOW, 60_000) }, 'AUTHORIZATION_EXPIRED'],
      [{ transactionBytes: new Uint8Array([9, 9]) }, {}, 'TRANSACTION_HASH_MISMATCH'],
    ];
    for (const [over, exp, reason] of cases) {
      const v = await checkOrderAgainstAuthorization(await order(over), intent(), { tradingWallet: exp.tradingWallet ?? 'wallet', now: exp.now ?? NOW, currentBlockHeight: exp.currentBlockHeight === undefined ? 900 : exp.currentBlockHeight });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
  });
});
