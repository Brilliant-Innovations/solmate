import { z } from 'zod';
import { Fraction, Milliseconds, MintAddress, VersionId } from '../primitives.js';

// §6.3, §8.4, D23: deterministic, versioned risk cohorts -----------------------------------------

/**
 * Human-maintained taxonomy (D23). Membership here is MANUAL and becomes ACTIVE when the version is
 * installed; an LLM may only ever produce INACTIVE_SUGGESTION rows. Mints not listed belong to no
 * cohort, which the risk policy treats as "unknown capacity" (most restrictive when required).
 * Editing this list is a versioned, reviewed change: bump `version` and the memberships' effective
 * version follows.
 */
export const CohortTaxonomyPolicy = z.strictObject({
  version: VersionId,
  cohorts: z.array(z.strictObject({ name: z.string().min(1).max(64), description: z.string().min(1).max(200) })).min(1),
  memberships: z.array(z.strictObject({ mint: MintAddress, cohort: z.string().min(1).max(64), confidence: Fraction })),
});
export type CohortTaxonomyPolicy = z.infer<typeof CohortTaxonomyPolicy>;

export const DEFAULT_COHORT_TAXONOMY: CohortTaxonomyPolicy = {
  version: 'cohorts-v1' as VersionId,
  cohorts: [
    { name: 'memes', description: 'Meme and narrative tokens with no protocol cash flow' },
    { name: 'dex-defi', description: 'DEX, aggregator, lending and perps protocol tokens' },
    { name: 'liquid-staking', description: 'Liquid staking tokens and their governance tokens' },
    { name: 'infra-oracle', description: 'Oracles, bridges and cross-chain infrastructure' },
    { name: 'depin-compute', description: 'Physical infrastructure and compute networks' },
    { name: 'nft-gaming', description: 'NFT marketplaces and gaming tokens' },
    { name: 'stablecoins', description: 'Settlement and funding assets; never a risk position' },
  ],
  memberships: [
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress, cohort: 'memes', confidence: 0.95 }, // BONK
    { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' as MintAddress, cohort: 'memes', confidence: 0.95 }, // WIF
    { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' as MintAddress, cohort: 'memes', confidence: 0.9 }, // POPCAT
    { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' as MintAddress, cohort: 'memes', confidence: 0.9 }, // MEW
    { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' as MintAddress, cohort: 'memes', confidence: 0.9 }, // BOME
    { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' as MintAddress, cohort: 'dex-defi', confidence: 0.95 }, // JUP
    { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' as MintAddress, cohort: 'dex-defi', confidence: 0.95 }, // RAY
    { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' as MintAddress, cohort: 'dex-defi', confidence: 0.95 }, // ORCA
    { mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7' as MintAddress, cohort: 'dex-defi', confidence: 0.9 }, // DRIFT
    { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS' as MintAddress, cohort: 'dex-defi', confidence: 0.9 }, // KMNO
    { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So' as MintAddress, cohort: 'liquid-staking', confidence: 0.95 }, // mSOL
    { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' as MintAddress, cohort: 'liquid-staking', confidence: 0.95 }, // jitoSOL
    { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' as MintAddress, cohort: 'liquid-staking', confidence: 0.9 }, // JTO
    { mint: 'HZ1JovNiVvGrGNiiYvEozEVjZ58xaU3RKwX8eACQBCt3' as MintAddress, cohort: 'infra-oracle', confidence: 0.9 }, // PYTH
    { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' as MintAddress, cohort: 'infra-oracle', confidence: 0.9 }, // W
    { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' as MintAddress, cohort: 'depin-compute', confidence: 0.9 }, // RENDER
    { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux' as MintAddress, cohort: 'depin-compute', confidence: 0.9 }, // HNT
    { mint: 'BZLbGTNCSFfoth2GYDtwr7e4imWzpR5jqcUuGEwr646K' as MintAddress, cohort: 'depin-compute', confidence: 0.85 }, // IO
    { mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6' as MintAddress, cohort: 'nft-gaming', confidence: 0.85 }, // TNSR
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress, cohort: 'stablecoins', confidence: 1 }, // USDC
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as MintAddress, cohort: 'stablecoins', confidence: 1 }, // USDT
  ],
};

// §6.3 rolling return-correlation clusters ------------------------------------------------------

/**
 * Deterministic clustering parameters. Returns are sampled from closed 1m candles at `sampleMinutes`
 * spacing over `windowMs`; assets with fewer than `minSamples` aligned samples are left unclustered
 * (unknown cluster). Average-linkage agglomeration merges groups while their mean pairwise Pearson
 * correlation is at least `linkThreshold`; ties break on asset id so the result is a pure function
 * of the inputs.
 */
export const CorrelationClusterPolicy = z.strictObject({
  version: VersionId,
  windowMs: Milliseconds,
  sampleMinutes: z.number().int().positive(),
  minSamples: z.number().int().positive(),
  linkThreshold: Fraction,
  minClusterSize: z.number().int().min(2),
});
export type CorrelationClusterPolicy = z.infer<typeof CorrelationClusterPolicy>;

export const DEFAULT_CORRELATION_CLUSTER_POLICY: CorrelationClusterPolicy = {
  version: 'clusters-v1' as VersionId,
  windowMs: 24 * 3_600_000,
  sampleMinutes: 5,
  minSamples: 96,
  linkThreshold: 0.6,
  minClusterSize: 2,
};
