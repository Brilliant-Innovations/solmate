import type { Amount, DirectPoolHop, EmergencyDryRunClass, EmergencyRoutePolicy, Instant, MintAddress } from '@sol-agent-trader/contracts';
import { fromBase64, toBase64, encodeTransaction, type DecodedMessage } from '../tx/codec.js';
import type { SimulationOutcome, SimulationReader } from '../simulate/client.js';
import { decodeTokenAccount } from '../simulate/token-account.js';
import { COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM } from '../validate/programs.js';
import { associatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID, concat, u32le, u64le } from './bytes.js';
import { RaydiumAmmV4Adapter } from './raydium-amm-v4.js';
import { RaydiumCpmmAdapter } from './raydium-cpmm.js';
import { MeteoraDlmmAdapter } from './meteora-dlmm.js';
import { RaydiumClmmAdapter } from './raydium-clmm.js';
import { OrcaWhirlpoolAdapter } from './orca-whirlpool.js';
import { PoolDecodeError, type AccountMeta, type DecodedPoolState, type DirectPoolAdapter, type DirectPoolInstruction, type PoolQuote, type RawAccount } from './types.js';

/**
 * Emergency-route dry-run (blueprint §14.6 "periodic unsigned build+simulation dry-run", D33; plan
 * M8b). Reads the snapshot's pool accounts, quotes locally, builds the exact transaction the
 * executor would sign (create-ATA idempotent, compute budget, direct-pool swap) and simulates it
 * unsigned with the trading wallet as payer. A wallet that does not hold the asset still proves
 * the shape: the swap program accepts every account and only the token transfer fails for balance,
 * which is classified OK_UNFUNDED. Nothing here signs or submits.
 */

export const DEFAULT_DIRECT_POOL_ADAPTERS: readonly DirectPoolAdapter[] = [new RaydiumCpmmAdapter(), new RaydiumAmmV4Adapter(), new MeteoraDlmmAdapter(), new RaydiumClmmAdapter(), new OrcaWhirlpoolAdapter()];

export function adapterFor(hop: DirectPoolHop, adapters: readonly DirectPoolAdapter[] = DEFAULT_DIRECT_POOL_ADAPTERS): DirectPoolAdapter | null {
  return adapters.find((a) => a.program === hop.program && a.programId === hop.programId) ?? null;
}

/** ATA program instruction 1: create the associated token account only when it does not exist yet. */
export function createAtaIdempotentInstruction(payer: string, ata: string, owner: string, mint: string, tokenProgram: string): DirectPoolInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  };
}

export function computeBudgetInstructions(unitLimit: number, unitPriceMicroLamports: number): DirectPoolInstruction[] {
  return [
    { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concat(new Uint8Array([2]), u32le(unitLimit)) },
    { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concat(new Uint8Array([3]), u64le(BigInt(unitPriceMicroLamports))) },
  ];
}

const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

/**
 * Compiles instructions into a legacy message: payer first, then writable signers, readonly
 * signers, writable non-signers, readonly non-signers, in first-seen order. Programs are readonly.
 */
export function compileLegacyMessage(payer: string, instructions: readonly DirectPoolInstruction[], recentBlockhash: string = PLACEHOLDER_BLOCKHASH): DecodedMessage {
  const metas = new Map<string, AccountMeta>();
  const merge = (m: AccountMeta) => {
    const cur = metas.get(m.pubkey);
    if (cur) {
      cur.isSigner = cur.isSigner || m.isSigner;
      cur.isWritable = cur.isWritable || m.isWritable;
    } else metas.set(m.pubkey, { ...m });
  };
  merge({ pubkey: payer, isSigner: true, isWritable: true });
  for (const ix of instructions) {
    for (const a of ix.accounts) merge(a);
    merge({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const all = [...metas.values()];
  const keys = [
    ...all.filter((m) => m.isSigner && m.isWritable),
    ...all.filter((m) => m.isSigner && !m.isWritable),
    ...all.filter((m) => !m.isSigner && m.isWritable),
    ...all.filter((m) => !m.isSigner && !m.isWritable),
  ];
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));
  return {
    version: 'legacy',
    header: {
      numRequiredSignatures: keys.filter((k) => k.isSigner).length,
      numReadonlySigned: keys.filter((k) => k.isSigner && !k.isWritable).length,
      numReadonlyUnsigned: keys.filter((k) => !k.isSigner && !k.isWritable).length,
    },
    staticAccountKeys: keys.map((k) => k.pubkey),
    recentBlockhash,
    instructions: instructions.map((ix) => ({ programIdIndex: index.get(ix.programId)!, accountIndexes: ix.accounts.map((a) => index.get(a.pubkey)!), data: ix.data })),
    addressTableLookups: [],
  };
}

export interface EmergencyBuild {
  adapter: DirectPoolAdapter;
  state: DecodedPoolState;
  quote: PoolQuote;
  userSource: string;
  userDestination: string;
  minimumAmountOut: bigint;
  message: DecodedMessage;
  /** Unsigned transaction, base64, exactly what an executor would sign. */
  unsignedTransactionBase64: string;
  accountsSlot: number;
}

export interface EmergencyBuildInput {
  hop: DirectPoolHop;
  user: string;
  /** The caller's clock; pools with an open time are judged against it (§18.2: no wall clock inside libraries). */
  now: Instant;
  /** Source token account to debit; defaults to the user's ATA for the input mint. A stand-in holder's real account goes here. */
  userSource?: string;
  amountIn: bigint;
  slippageBps: number;
  policy: Pick<EmergencyRoutePolicy, 'computeUnitLimit' | 'computeUnitPriceMicroLamports'>;
  reader: Pick<SimulationReader, 'accounts'>;
  adapters?: readonly DirectPoolAdapter[];
}

function toRaw(snapshot: { address: string; lamports: number; owner: string; dataBase64: string } | null): RawAccount | null {
  return snapshot ? { address: snapshot.address, owner: snapshot.owner, lamports: snapshot.lamports, data: fromBase64(snapshot.dataBase64) } : null;
}

/** Reads fresh pool state and builds the unsigned emergency transaction for one hop (§14.6 steps 4–5). */
export async function buildEmergencyExit(input: EmergencyBuildInput): Promise<EmergencyBuild> {
  const adapter = adapterFor(input.hop, input.adapters);
  if (!adapter) throw new PoolDecodeError(input.hop.program, `no local adapter for ${input.hop.program} (${input.hop.programId})`);
  const first = await input.reader.accounts(await adapter.requiredAccounts(input.hop));
  const pool = toRaw(first.accounts[0] ?? null);
  if (!pool) throw new PoolDecodeError(input.hop.program, `pool ${input.hop.poolAddress} does not exist`);
  const dependent = adapter.dependentAccounts(input.hop, pool);
  const second = dependent.length ? await input.reader.accounts(dependent) : { slot: first.slot, accounts: [] };
  const state = adapter.decode(input.hop, [pool, ...first.accounts.slice(1).map(toRaw), ...second.accounts.map(toRaw)], { nowMs: Date.parse(input.now) });
  const quote = adapter.quote(state, input.hop.inputMint, input.amountIn);
  const inputProgram = input.hop.inputMint === state.mintA ? state.tokenProgramA : state.tokenProgramB;
  const outputProgram = input.hop.inputMint === state.mintA ? state.tokenProgramB : state.tokenProgramA;
  const userSource = input.userSource ?? associatedTokenAddress(input.user, input.hop.inputMint, inputProgram);
  const userDestination = associatedTokenAddress(input.user, quote.outputMint, outputProgram);
  const expected = BigInt(quote.expectedOutputAmount);
  const minimumAmountOut = (expected * BigInt(10_000 - input.slippageBps)) / 10_000n;
  const instructions = [
    ...computeBudgetInstructions(input.policy.computeUnitLimit, input.policy.computeUnitPriceMicroLamports),
    createAtaIdempotentInstruction(input.user, userDestination, input.user, quote.outputMint, outputProgram),
    adapter.swapInstruction({ state, user: input.user, inputMint: input.hop.inputMint, userSource, userDestination, amountIn: input.amountIn, minimumAmountOut }),
  ];
  const message = compileLegacyMessage(input.user, instructions);
  return { adapter, state, quote, userSource, userDestination, minimumAmountOut, message, unsignedTransactionBase64: toBase64(encodeTransaction([null], message)), accountsSlot: Math.max(first.slot, second.slot) };
}

export interface DryRunResult {
  class: EmergencyDryRunClass;
  ok: boolean;
  at: Instant;
  slot: number | null;
  quote: PoolQuote | null;
  simulatedOutputAmount: Amount | null;
  tradeable: boolean | null;
  unitsConsumed: number | null;
  error: string | null;
  logsTail: string[];
}

const INSUFFICIENT_FUNDS = /insufficient funds|Error: insufficient funds|custom program error: 0x1\b/i;
/** The payer holds none of the input token: Anchor 3012 on the input account (CPMM) or the AMM v4 owner check on the user source (error 38, "Invalid SPL token program"). */
const SOURCE_MISSING = /AccountNotInitialized[^|]*|caused by account: (input_token_account|user_source|source)|Invalid SPL token program/i;

/** Classifies a simulation of the built emergency transaction; pure so it can be tested from captured logs. */
export function classifyDryRun(build: Pick<EmergencyBuild, 'adapter' | 'state' | 'quote' | 'userDestination' | 'minimumAmountOut'>, sim: SimulationOutcome, before: bigint | null, slippageBps: number): Pick<DryRunResult, 'class' | 'ok' | 'simulatedOutputAmount' | 'error'> {
  const programInvoked = sim.logs.some((l) => l.startsWith(`Program ${build.adapter.programId} invoke`));
  if (sim.err === null) {
    const destAfter = sim.accounts.find((a) => a?.address === build.userDestination) ?? null;
    let simulatedOutput: bigint | null = null;
    if (destAfter) {
      try {
        const after = decodeTokenAccount(fromBase64(destAfter.dataBase64)).amount;
        simulatedOutput = before === null ? after : after - before;
      } catch {
        simulatedOutput = null;
      }
    }
    if (simulatedOutput !== null) {
      const expected = BigInt(build.quote.expectedOutputAmount);
      const floor = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
      if (simulatedOutput < floor) return { class: 'SLIPPAGE_EXCEEDED', ok: false, simulatedOutputAmount: simulatedOutput.toString() as Amount, error: `simulated ${simulatedOutput} below ${floor} (quote ${expected})` };
    }
    return { class: 'OK', ok: true, simulatedOutputAmount: simulatedOutput === null ? null : (simulatedOutput.toString() as Amount), error: null };
  }
  const errText = typeof sim.err === 'string' ? sim.err : JSON.stringify(sim.err);
  // The runtime rejects a fee payer with no lamports before any program runs: nothing about the pool was tested.
  if (errText.replace(/"/g, '') === 'AccountNotFound' && sim.logs.length === 0) return { class: 'PAYER_UNFUNDED', ok: false, simulatedOutputAmount: null, error: 'fee payer has no SOL; the dry-run could not run (fund the trading wallet gas reserve)' };
  const insufficient = sim.logs.some((l) => INSUFFICIENT_FUNDS.test(l)) || INSUFFICIENT_FUNDS.test(errText);
  if (programInvoked && insufficient) return { class: 'OK_UNFUNDED', ok: true, simulatedOutputAmount: null, error: `shape accepted; wallet balance missing (${errText.slice(0, 120)})` };
  if (programInvoked && sim.logs.some((l) => SOURCE_MISSING.test(l))) return { class: 'SOURCE_ACCOUNT_MISSING', ok: false, simulatedOutputAmount: null, error: `payer holds no ${build.quote.inputMint} token account; the swap could not be proven (use a holder as stand-in payer)` };
  return { class: 'POOL_REJECTED', ok: false, simulatedOutputAmount: null, error: `${errText.slice(0, 160)}${sim.logs.length ? ` · ${sim.logs.slice(-3).join(' | ').slice(0, 300)}` : ''}` };
}

export interface DryRunInput extends EmergencyBuildInput {
  reader: SimulationReader;
}

/** Full dry-run: build, simulate unsigned, classify. Never throws for a pool problem; RPC/decode failures are classified too. */
export async function runEmergencyDryRun(input: DryRunInput): Promise<DryRunResult & { build: EmergencyBuild | null }> {
  const base: DryRunResult = { class: 'RPC_ERROR', ok: false, at: input.now, slot: null, quote: null, simulatedOutputAmount: null, tradeable: null, unitsConsumed: null, error: null, logsTail: [] };
  if (!adapterFor(input.hop, input.adapters)) return { ...base, class: 'UNSUPPORTED_PROGRAM', error: `no local adapter for ${input.hop.program}`, build: null };
  let build: EmergencyBuild;
  try {
    build = await buildEmergencyExit(input);
  } catch (err) {
    if (err instanceof PoolDecodeError) return { ...base, class: 'DECODE_FAILED', error: err.message, build: null };
    return { ...base, class: 'RPC_ERROR', error: err instanceof Error ? err.message : String(err), build: null };
  }
  if (!build.state.tradeable) return { ...base, class: 'POOL_REJECTED', slot: build.accountsSlot, quote: build.quote, tradeable: false, error: `pool not tradeable: ${build.state.tradeableReason ?? 'unknown'}`, build };
  try {
    const pre = await input.reader.accounts([build.userDestination]);
    let before: bigint | null = null;
    const dest = pre.accounts[0];
    if (dest) {
      try {
        before = decodeTokenAccount(fromBase64(dest.dataBase64)).amount;
      } catch {
        before = null;
      }
    } else before = 0n;
    const sim = await input.reader.simulate(build.unsignedTransactionBase64, [build.userDestination]);
    const c = classifyDryRun(build, sim, before, input.slippageBps);
    return { ...base, ...c, slot: sim.slot, quote: build.quote, tradeable: true, unitsConsumed: sim.unitsConsumed, logsTail: sim.logs.slice(-6), build };
  } catch (err) {
    return { ...base, class: 'RPC_ERROR', slot: build.accountsSlot, quote: build.quote, tradeable: true, error: err instanceof Error ? err.message : String(err), build };
  }
}

export type { MintAddress };
