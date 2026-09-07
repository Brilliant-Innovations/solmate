import type { DirectPoolProgram } from '@sol-agent-trader/contracts';

/**
 * Direct-pool program families the emergency-exit adapter supports (blueprint §14.6), their
 * mainnet program ids, and the labels Jupiter's router uses for them
 * (GET /swap/v1/program-id-to-label, verified 2026-09-07). Program ids are also verified against
 * the pool account's owner on chain before a snapshot is persisted (D45).
 */
export const DIRECT_POOL_PROGRAMS: Readonly<Record<DirectPoolProgram, { programId: string; jupiterLabel: string }>> = {
  RAYDIUM_AMM_V4: { programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', jupiterLabel: 'Raydium' },
  RAYDIUM_CPMM: { programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', jupiterLabel: 'Raydium CP' },
  RAYDIUM_CLMM: { programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', jupiterLabel: 'Raydium CLMM' },
  ORCA_WHIRLPOOL: { programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', jupiterLabel: 'Whirlpool' },
  METEORA_DLMM: { programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', jupiterLabel: 'Meteora DLMM' },
};

export const DIRECT_POOL_LABELS: readonly string[] = Object.values(DIRECT_POOL_PROGRAMS).map((p) => p.jupiterLabel);

export function programForLabel(label: string): { program: DirectPoolProgram; programId: string } | null {
  for (const [program, p] of Object.entries(DIRECT_POOL_PROGRAMS) as [DirectPoolProgram, { programId: string; jupiterLabel: string }][]) {
    if (p.jupiterLabel === label) return { program, programId: p.programId };
  }
  return null;
}
