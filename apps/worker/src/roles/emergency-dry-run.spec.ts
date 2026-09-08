import { DEFAULT_EMERGENCY_ROUTE_POLICY, fixedClock, fixtures, toInstant, type EmergencyExitRouteSnapshot, type Instant, type MintAddress, type SolanaAddress, type Uuid } from '@sol-agent-trader/contracts';
import type { DryRunTarget } from '@sol-agent-trader/db/server';
import { MAINNET_POOL_FIXTURES, type SimulationReader } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { dryRunAmount, runEmergencyDryRunCycle, type EmergencyDryRunDeps } from './emergency-dry-run.js';

const NOW = fixtures.T0 as Instant;
const SOL = 'So11111111111111111111111111111111111111112' as MintAddress;
const WALLET = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const A1 = '00000000-0000-4000-8000-0000000000a1' as Uuid;
const A2 = '00000000-0000-4000-8000-0000000000a2' as Uuid;
const A3 = '00000000-0000-4000-8000-0000000000a3' as Uuid;
const A4 = '00000000-0000-4000-8000-0000000000a4' as Uuid;

const snap = (assetId: Uuid, program: EmergencyExitRouteSnapshot['hops'][0]['program'], over: Partial<EmergencyExitRouteSnapshot> = {}): EmergencyExitRouteSnapshot => ({
  id: `${assetId.slice(0, 35)}f` as Uuid,
  assetId,
  hops: [{ program, programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' as SolanaAddress, poolAddress: 'AiP94aqcnsxPfHTQLerdwNACedhmEUxMaaSxevS2Drxm' as SolanaAddress, inputMint: 'HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd' as MintAddress, outputMint: SOL }],
  settlementMint: SOL,
  poolStateRef: 'slot:1',
  lastRefreshedAt: toInstant(Date.parse(NOW) - 3_600_000),
  lastRefreshSlot: 1 as EmergencyExitRouteSnapshot['lastRefreshSlot'],
  capacity: [{ inputAmount: '5000000000' as never, expectedOutputAmount: '1' as never, impactBps: 1 as never }, { inputAmount: '1000000000' as never, expectedOutputAmount: '1' as never, impactBps: 1 as never }],
  token2022Compatible: true,
  lastDryRun: null,
  ...over,
});

function reader(): SimulationReader {
  const all = MAINNET_POOL_FIXTURES.cpmm.accounts.filter((a): a is NonNullable<typeof a> => a !== null);
  return {
    label: 'fixture',
    async accounts(addresses) {
      return { slot: 500, accounts: addresses.map((x) => all.find((a) => a.address === x) ?? null) };
    },
    async simulate() {
      return { slot: 501, err: { InstructionError: [3, { Custom: 1 }] }, logs: ['Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]', 'Program log: Error: insufficient funds'], unitsConsumed: 30_000, accounts: [null] };
    },
  };
}

describe('emergency-dry-run role (§14.6, D33)', () => {
  it('proves the smallest capacity size, appends a refreshed snapshot with the verdict, skips targets without a snapshot or not yet due, and records unsupported families as failed dry-runs', async () => {
    const targets: DryRunTarget[] = [
      { assetId: A1, mint: 'HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd' as MintAddress, decimals: 9, held: true, lastDryRunAt: null },
      { assetId: A2, mint: 'BANKJmvhT8tiJRsBSS1n2HryMBPvT5Ze4HU95DUAmeta' as MintAddress, decimals: 6, held: false, lastDryRunAt: null },
      { assetId: A3, mint: 'x' as MintAddress, decimals: 6, held: false, lastDryRunAt: toInstant(Date.parse(NOW) - 60_000) },
      { assetId: A4, mint: 'HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd' as MintAddress, decimals: 9, held: false, lastDryRunAt: null },
    ];
    const standIns: string[] = [];
    const inserted: EmergencyExitRouteSnapshot[] = [];
    let n = 0;
    const deps: EmergencyDryRunDeps = {
      repo: {
        async targets() { return targets; },
        async latestSnapshots(ids) { const m = new Map<Uuid, EmergencyExitRouteSnapshot>(); if (ids.includes(A1)) m.set(A1, snap(A1, 'RAYDIUM_CPMM')); if (ids.includes(A2)) m.set(A2, snap(A2, 'METEORA_DLMM')); if (ids.includes(A4)) m.set(A4, snap(A4, 'RAYDIUM_CPMM')); return m; },
        async insertSnapshot(s) { inserted.push(s); },
      },
      reader: reader(),
      tradingWallet: WALLET,
      standInPayer: async (mint) => { standIns.push(mint); return { owner: 'GcaEn64W365GziEmvpLvAkjAW7wHjnPfjx71KVQNPmjE', tokenAccount: 'BaorCoZHp26WNmWZEJPKJYUQ98D4mRtx18v4euTukPT3' }; },
      policy: DEFAULT_EMERGENCY_ROUTE_POLICY,
      clock: fixedClock(NOW),
      logger,
      newId: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-00000000d0d0` as Uuid,
      config: {},
    };
    expect(dryRunAmount(snap(A1, 'RAYDIUM_CPMM'), 9)).toBe(1_000_000_000n);
    expect(dryRunAmount(snap(A1, 'RAYDIUM_CPMM', { capacity: [] }), 6)).toBe(1_000_000n);
    const r = await runEmergencyDryRunCycle(deps);
    expect(r).toMatchObject({ targets: 4, due: 3, ran: 3, outcomes: { OK_UNFUNDED: 2, UNSUPPORTED_PROGRAM: 1 }, unsupported: 1, noSnapshot: 0 });
    expect(r.errors).toEqual([]);
    expect(inserted).toHaveLength(3);
    // the held asset simulates as the trading wallet; the unheld supported one as its largest holder; the unsupported one asks nobody
    expect(standIns).toEqual(['HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd']);
    const a1 = inserted.find((s) => s.assetId === A1)!;
    expect(a1.id).not.toBe(snap(A1, 'RAYDIUM_CPMM').id);
    expect(a1.lastDryRun).toMatchObject({ at: NOW, ok: true, simulatedOutputAmount: null });
    expect(a1.lastDryRun?.error).toMatch(/^OK_UNFUNDED: shape accepted/);
    expect(a1.lastRefreshSlot).toBe(501);
    expect(a1.poolStateRef).toBe('slot:501');
    // capacity re-quoted from the fresh pool state, same input sizes
    expect(a1.capacity.map((c) => c.inputAmount)).toEqual(['5000000000', '1000000000']);
    expect(BigInt(a1.capacity[0]!.expectedOutputAmount)).toBeGreaterThan(1n);
    const a2 = inserted.find((s) => s.assetId === A2)!;
    expect(a2.lastDryRun).toMatchObject({ ok: false });
    expect(a2.lastDryRun?.error).toMatch(/^UNSUPPORTED_PROGRAM/);
    expect(a2.lastRefreshSlot).toBe(1);
  });
});
