import type { QuoteProbe } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';

/** Append-only quote capture for Level B replay (§18.1). Failures here must never block a decision; callers log and continue. */
export async function insertQuoteProbes(sql: Sql, probes: readonly QuoteProbe[]): Promise<number> {
  if (probes.length === 0) return 0;
  let n = 0;
  for (const p of probes) {
    await sql`
      insert into market.quote_probes (id, asset_id, provider, purpose, input_mint, output_mint, input_amount, expected_output_amount, min_output_amount, price_impact_bps, slippage_bps, router_label, route_program_ids, uses_address_lookup_tables, quoted_at, observed_at, action_cycle_id, intent_id, position_id, order_attempt_id)
      values (${p.id}, ${p.assetId}, ${p.provider}, ${p.purpose}, ${p.inputMint}, ${p.outputMint}, ${p.inputAmount}, ${p.expectedOutputAmount}, ${p.minOutputAmount}, ${p.priceImpactBps}, ${p.slippageBps}, ${p.routerLabel}, ${p.routeProgramIds}, ${p.usesAddressLookupTables}, ${p.quotedAt}, ${p.observedAt}, ${p.actionCycleId}, ${p.intentId}, ${p.positionId}, ${p.orderAttemptId})
      on conflict (id) do nothing`;
    n++;
  }
  return n;
}

/** Probes for one action cycle in the order they were taken: the Inspector's "what did the executor see" view. */
export async function listQuoteProbesForCycle(sql: Sql, actionCycleId: string): Promise<Pick<QuoteProbe, 'purpose' | 'inputAmount' | 'expectedOutputAmount' | 'priceImpactBps' | 'quotedAt'>[]> {
  const rows = await sql<{ purpose: QuoteProbe['purpose']; input_amount: string; expected_output_amount: string; price_impact_bps: number | null; quoted_at: string }[]>`
    select purpose, input_amount::text, expected_output_amount::text, price_impact_bps, quoted_at from market.quote_probes where action_cycle_id = ${actionCycleId} order by quoted_at asc, observed_at asc`;
  return rows.map((r) => ({ purpose: r.purpose, inputAmount: r.input_amount as QuoteProbe['inputAmount'], expectedOutputAmount: r.expected_output_amount as QuoteProbe['expectedOutputAmount'], priceImpactBps: r.price_impact_bps as QuoteProbe['priceImpactBps'], quotedAt: new Date(r.quoted_at).toISOString() as QuoteProbe['quotedAt'] }));
}
