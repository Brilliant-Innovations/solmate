import { addMs, amountToBigInt, applyBps, instantToMs, mulDiv, type Amount, type Bps, type Candle, type Instant, type JupiterQuoteClient, type MintAddress, type OrderBuild, type Quote, type QuoteProbe, type QuoteRequest, type QuoteRoutePlan, type Uuid } from '@sol-agent-trader/contracts';
import { guardedCandles, guardedRows, type GuardContext } from '@sol-agent-trader/replay';
import type { ReplayAsset, ReplayDataset } from './types.js';

/**
 * Replay quote source (blueprint §18.1, §18.4). Implements the quote client the paper adapter
 * already uses, so the fill model, pre-submit checks and attempt state machine run unchanged.
 *
 *   Level B — captured-market replay: the nearest captured probe for the pair taken at or before
 *   the requested moment (and observed before the dataset cutoff) supplies price and impact;
 *   the output is scaled to the requested amount and the impact is scaled with size.
 *   Level A — historical: the last visible 1m close supplies price; impact is modelled from the
 *   asset's latest visible eligibility probes (or the cost model's default when none exist).
 *
 * Every lookup is guarded: asking for a quote later than the replay clock throws. No route is a
 * NoRouteError, exactly what the live client raises, so the adapter records NO_ROUTE.
 */

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRouteError';
  }
}

export interface QuoteSourceOptions {
  fidelity: 'A_HISTORICAL' | 'B_CAPTURED' | 'C_LIVE_PAPER';
  settlementMint: MintAddress;
  settlementDecimals: number;
  /** Level B: a probe older than this at the requested moment is not "contemporaneous". */
  maxProbeAgeMs: number;
  /** Level A: impact when no eligibility probe covers the size. */
  defaultImpactBps: Bps;
  /** Level A: linear impact model; bps per USD of size above the smallest probe. */
  slippageBps: Bps;
  candleAvailabilityLagMs: number;
}

const ONE_E12 = 1_000_000_000_000n;

export class ReplayQuoteSource implements JupiterQuoteClient {
  constructor(
    private readonly dataset: ReplayDataset,
    private readonly guard: GuardContext,
    private readonly opts: QuoteSourceOptions,
  ) {}

  async quote(request: QuoteRequest): Promise<{ quote: Quote; route: QuoteRoutePlan }> {
    const asset = this.assetFor(request.inputMint, request.outputMint);
    const at = request.requestedAt;
    const buying = request.inputMint === this.opts.settlementMint;
    const probe = this.opts.fidelity === 'B_CAPTURED' ? this.nearestProbe(asset, request.inputMint, request.outputMint, at) : null;
    const { price, impactBps } = probe ? this.fromProbe(probe, asset, request.inputAmount, buying) : this.fromCandles(asset, at, request.inputAmount, buying);
    const expected = buying ? unitsOut(request.inputAmount, price, this.opts.settlementDecimals, asset.decimals, impactBps) : unitsIn(request.inputAmount, price, asset.decimals, this.opts.settlementDecimals, impactBps);
    if (amountToBigInt(expected) === 0n) throw new NoRouteError(`no executable output for ${request.inputAmount} at ${at}`);
    const quote: Quote = {
      provider: 'JUPITER',
      providerRequestId: null,
      routerLabel: probe ? (probe.routerLabel ?? 'replay:captured') : 'replay:historical',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmount: request.inputAmount,
      expectedOutputAmount: expected,
      minOutputAmount: applyBps(expected, 10_000 - request.maxSlippageBps, 'FLOOR'),
      priceImpactBps: impactBps,
      slippageBps: request.maxSlippageBps,
      routeProgramIds: probe?.routeProgramIds ?? [],
      usesAddressLookupTables: probe?.usesAddressLookupTables ?? false,
      quotedAt: at,
      expiresAt: addMs(at, 30_000),
      lastValidBlockHeight: null,
    };
    return { quote, route: { contextSlot: null, hops: [] } as unknown as QuoteRoutePlan };
  }

  async buildOrder(_request: QuoteRequest): Promise<OrderBuild> {
    throw new Error('replay never builds an order');
  }

  private assetFor(inputMint: MintAddress, outputMint: MintAddress): ReplayAsset {
    const other = inputMint === this.opts.settlementMint ? outputMint : inputMint;
    const asset = this.dataset.assets.find((a) => a.mint === other);
    if (!asset) throw new NoRouteError(`asset ${other} is not in the replay dataset`);
    return asset;
  }

  private nearestProbe(asset: ReplayAsset, inputMint: MintAddress, outputMint: MintAddress, at: Instant): QuoteProbe | null {
    const rows = guardedRows('quote_probes', (this.dataset.quoteProbes.get(asset.id) ?? []).map((p) => ({ ...p, firstSeenAt: p.quotedAt })), at, this.guard);
    const same = rows.filter((p) => p.inputMint === inputMint && p.outputMint === outputMint && instantToMs(at) - instantToMs(p.quotedAt) <= this.opts.maxProbeAgeMs);
    if (same.length === 0) return null;
    return same.reduce((best, p) => (instantToMs(p.quotedAt) > instantToMs(best.quotedAt) ? p : best));
  }

  /** Settlement per token from the probe, impact scaled linearly with the size ratio. */
  private fromProbe(probe: QuoteProbe, asset: ReplayAsset, inputAmount: Amount, buying: boolean): { price: number; impactBps: Bps } {
    const inUnits = Number(amountToBigInt(probe.inputAmount)) / 10 ** (buying ? this.opts.settlementDecimals : asset.decimals);
    const outUnits = Number(amountToBigInt(probe.expectedOutputAmount)) / 10 ** (buying ? asset.decimals : this.opts.settlementDecimals);
    if (inUnits <= 0 || outUnits <= 0) throw new NoRouteError('captured probe has no price');
    // The probe's expected output already includes its own impact; back it out to a mid price, then re-apply for this size.
    const probeImpact = probe.priceImpactBps ?? 0;
    const executed = buying ? inUnits / outUnits : outUnits / inUnits;
    const mid = buying ? executed * (1 - probeImpact / 10_000) : executed / (1 - probeImpact / 10_000);
    const ratio = Number(amountToBigInt(inputAmount)) / Number(amountToBigInt(probe.inputAmount));
    const impactBps = Math.min(10_000, Math.round(probeImpact * ratio)) as Bps;
    return { price: mid, impactBps };
  }

  private fromCandles(asset: ReplayAsset, at: Instant, inputAmount: Amount, buying: boolean): { price: number; impactBps: Bps } {
    const visible = guardedCandles('candles', this.dataset.candles.get(asset.id) ?? [], 60_000, this.opts.candleAvailabilityLagMs, at, this.guard);
    if (visible.length === 0) throw new NoRouteError(`no visible candle for ${asset.symbol} at ${at}`);
    const last = visible.reduce((b, c) => (instantToMs(c.bucketTime) > instantToMs(b.bucketTime) ? c : b));
    if (!(last.close > 0)) throw new NoRouteError(`zero close for ${asset.symbol} at ${last.bucketTime}`);
    const sizeUsd = buying ? Number(amountToBigInt(inputAmount)) / 10 ** this.opts.settlementDecimals : (Number(amountToBigInt(inputAmount)) / 10 ** asset.decimals) * last.close;
    return { price: last.close, impactBps: this.modelledImpact(asset, at, sizeUsd) };
  }

  private modelledImpact(asset: ReplayAsset, at: Instant, sizeUsd: number): Bps {
    const records = guardedRows('eligibility', (this.dataset.eligibility.get(asset.id) ?? []).map((e) => ({ ...e, firstSeenAt: e.evaluatedAt })), at, this.guard);
    const probes = records.flatMap((e) => e.priceImpactProbes).filter((p) => p.routeFound && p.impactBps !== null);
    if (probes.length === 0) return this.opts.defaultImpactBps;
    const sorted = [...probes].sort((a, b) => a.sizeUsd - b.sizeUsd);
    const atOrAbove = sorted.find((p) => p.sizeUsd >= sizeUsd) ?? sorted[sorted.length - 1]!;
    const scale = atOrAbove.sizeUsd > 0 ? Math.min(4, Math.max(0.1, sizeUsd / atOrAbove.sizeUsd)) : 1;
    return Math.min(10_000, Math.round((atOrAbove.impactBps as number) * scale)) as Bps;
  }
}

/** Token base units bought with `input` settlement base units at `price` settlement per token, less impact. */
export function unitsOut(input: Amount, price: number, inDecimals: number, outDecimals: number, impactBps: number): Amount {
  if (!(price > 0)) return '0' as Amount;
  const scaledPrice = BigInt(Math.round((1 / price) * 1e12));
  const raw = mulDiv(input, scaledPrice * 10n ** BigInt(outDecimals), ONE_E12 * 10n ** BigInt(inDecimals), 'FLOOR');
  return applyBps(raw, 10_000 - Math.min(10_000, Math.max(0, impactBps)), 'FLOOR');
}

/** Settlement base units received for `input` token base units at `price`, less impact. */
export function unitsIn(input: Amount, price: number, inDecimals: number, outDecimals: number, impactBps: number): Amount {
  if (!(price > 0)) return '0' as Amount;
  const scaledPrice = BigInt(Math.round(price * 1e12));
  const raw = mulDiv(input, scaledPrice * 10n ** BigInt(outDecimals), ONE_E12 * 10n ** BigInt(inDecimals), 'FLOOR');
  return applyBps(raw, 10_000 - Math.min(10_000, Math.max(0, impactBps)), 'FLOOR');
}

export function lastVisibleClose(candles: readonly Candle[], at: Instant, guard: GuardContext, lagMs: number): { close: number; high: number; bucketTime: Instant } | null {
  const visible = guardedCandles('candles', candles, 60_000, lagMs, at, guard);
  if (visible.length === 0) return null;
  const last = visible.reduce((b, c) => (instantToMs(c.bucketTime) > instantToMs(b.bucketTime) ? c : b));
  return { close: last.close, high: last.high, bucketTime: last.bucketTime };
}

export function idFrom(seed: string, n: number): Uuid {
  // Deterministic uuid-shaped id from the run seed and a counter (reproducibility, §18.5).
  let h = 2166136261 >>> 0;
  const s = `${seed}:${n}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hex = (x: number) => x.toString(16).padStart(8, '0');
  const a = hex(h);
  const b = hex(Math.imul(h ^ n, 2654435761) >>> 0);
  const c = hex(Math.imul(h + n, 40503) >>> 0);
  const d = hex((h * 31 + n) >>> 0);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`.slice(0, 36) as Uuid;
}
