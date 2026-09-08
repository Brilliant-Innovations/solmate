import { z } from 'zod';
import { SourceQualityClass } from '../enums.js';
import { Fraction, Milliseconds, VersionId } from '../primitives.js';

/**
 * Event normalization and dedupe policy (blueprint §10.1–10.4, §6.6, D64). Versioned and
 * deterministic: source quality comes from a pinned domain table (never from the text), two clocks
 * are kept apart (source time for catalyst age, first-seen for replay and novelty), and syndicated
 * copies cluster under one catalyst by URL, by normalized title similarity, or by the same
 * entities inside a short window.
 */
export const NormalizationPolicy = z.strictObject({
  version: VersionId,
  /** Domain (or suffix) → quality class; the longest matching suffix wins. Anything else is UNKNOWN_SOCIAL. */
  sourceQualityByDomain: z.record(z.string(), SourceQualityClass),
  /** Providers whose own timestamps are precise and trusted (HIGH); others fall to MEDIUM when a full timestamp exists. */
  highConfidenceTimeProviders: z.array(z.string()),
  /** How far back to look for a cluster to join. */
  dedupeWindowMs: Milliseconds,
  /** Jaccard similarity of title shingles at or above this joins the cluster. */
  titleSimilarityThreshold: Fraction,
  /** Same assets and a title similarity at or above this (weaker) also joins, as corroboration. */
  entitySimilarityThreshold: Fraction,
  /** Shingle size in tokens for title similarity. */
  shingleSize: z.number().int().min(1).max(4),
  /** D64: a catalyst older than this (by trustworthy source time) cannot open a fresh high-speed window. */
  maxFreshCatalystAgeMs: Milliseconds,
  /** Minimum symbol length for a bare (non-cashtag) symbol match in text. */
  minBareSymbolLength: z.number().int().min(2),
});
export type NormalizationPolicy = z.infer<typeof NormalizationPolicy>;

export const DEFAULT_NORMALIZATION_POLICY: NormalizationPolicy = {
  version: 'intel-v1' as VersionId,
  sourceQualityByDomain: {
    'sec.gov': 'PRIMARY_GOVERNMENT_REGULATORY',
    'cftc.gov': 'PRIMARY_GOVERNMENT_REGULATORY',
    'federalreserve.gov': 'PRIMARY_GOVERNMENT_REGULATORY',
    'europa.eu': 'PRIMARY_GOVERNMENT_REGULATORY',
    'solana.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'solana.org': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'jup.ag': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'raydium.io': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'orca.so': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'binance.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'coinbase.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'kraken.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'okx.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'bybit.com': 'OFFICIAL_EXCHANGE_PROTOCOL',
    'coindesk.com': 'REPUTABLE_PUBLICATION',
    'theblock.co': 'REPUTABLE_PUBLICATION',
    'cointelegraph.com': 'REPUTABLE_PUBLICATION',
    'decrypt.co': 'REPUTABLE_PUBLICATION',
    'bloomberg.com': 'REPUTABLE_PUBLICATION',
    'reuters.com': 'REPUTABLE_PUBLICATION',
    'wsj.com': 'REPUTABLE_PUBLICATION',
    'ft.com': 'REPUTABLE_PUBLICATION',
    'dlnews.com': 'REPUTABLE_PUBLICATION',
    'blockworks.co': 'REPUTABLE_PUBLICATION',
    'birdeye.so': 'ANALYTICS_PROVIDER',
    'lunarcrush.com': 'ANALYTICS_PROVIDER',
    'dexscreener.com': 'ANALYTICS_PROVIDER',
    'defillama.com': 'ANALYTICS_PROVIDER',
    'messari.io': 'ANALYTICS_PROVIDER',
    'nansen.ai': 'ANALYTICS_PROVIDER',
  },
  highConfidenceTimeProviders: ['CRYPTOPANIC', 'LUNARCRUSH'],
  dedupeWindowMs: 48 * 3_600_000,
  titleSimilarityThreshold: 0.6,
  entitySimilarityThreshold: 0.35,
  shingleSize: 2,
  maxFreshCatalystAgeMs: 6 * 3_600_000,
  minBareSymbolLength: 3,
};
