import { amountToBigInt, bigIntToAmount, mulDiv, type Amount, type RiskPolicy } from '@sol-agent-trader/contracts';

/**
 * Position sizing (blueprint §13.3; INV-02 "no intent amount greater than the risk-evaluated
 * maximum"; ADR-0007 unknown cohort = most restrictive; ADR-0009 P1 pending exposure counted).
 *
 *   risk_budget = min(equity × risk_per_trade, sleeve_risk_remaining)
 *   size_by_stop = risk_budget / stop_distance_fraction
 *   final = min(size_by_stop, sleeve_cap, max_position_value, cohort_remaining,
 *               cluster_remaining, liquidity_cap, available_capital)
 *
 * All base units of the settlement mint, bigint throughout, FLOOR at every division. The result
 * names the binding constraint so an evaluation can explain the number.
 */

export type SizingConstraint = 'RISK_BUDGET_BY_STOP' | 'SLEEVE_CAP' | 'MAX_POSITION_VALUE' | 'COHORT_REMAINING' | 'CLUSTER_REMAINING' | 'LIQUIDITY_CAP' | 'AVAILABLE_CAPITAL' | 'NONE';

export interface SizingInputs {
  policy: Pick<RiskPolicy, 'riskPerTradeFraction' | 'maxPositionValueBaseUnits' | 'liquidityCapFraction' | 'requireCohortCapacity'>;
  equityBaseUnits: Amount;
  /** Fraction of entry price to the stop; must be > 0. */
  stopDistanceFraction: number;
  sleeve: { capRemainingBaseUnits: Amount; riskRemainingBaseUnits: Amount } | null;
  /** Remaining cohort/cluster capacity in base units; null = unknown. */
  cohortRemainingBaseUnits: Amount | null;
  clusterRemainingBaseUnits: Amount | null;
  /** Quoted liquidity in settlement base units; null = unknown (treated as zero cap). */
  liquidityBaseUnits: Amount | null;
  /** Settlement available after reserves, minus pending (authorized/submitted/provisional) exposure. */
  availableCapitalBaseUnits: Amount;
}

export interface SizingResult {
  sizeBaseUnits: Amount;
  riskBudgetBaseUnits: Amount;
  sizeByStopBaseUnits: Amount;
  binding: SizingConstraint;
  caps: Record<Exclude<SizingConstraint, 'NONE'>, Amount | null>;
  /** Set when an unknown cohort/cluster forced the size to zero under ADR-0007. */
  unknownCapacity: 'COHORT' | 'CLUSTER' | null;
}

const MICRO = 1_000_000n;
const fraction = (amount: Amount, f: number): Amount => mulDiv(amount, BigInt(Math.round(Math.max(0, f) * 1_000_000)), MICRO, 'FLOOR');

export function computePositionSize(input: SizingInputs): SizingResult {
  const zero = '0' as Amount;
  const equity = amountToBigInt(input.equityBaseUnits);
  const riskByEquity = fraction(input.equityBaseUnits, input.policy.riskPerTradeFraction);
  const riskBudget = input.sleeve ? bigIntToAmount(min(amountToBigInt(riskByEquity), amountToBigInt(input.sleeve.riskRemainingBaseUnits))) : riskByEquity;

  if (!(input.stopDistanceFraction > 0) || !Number.isFinite(input.stopDistanceFraction) || equity === 0n) {
    return { sizeBaseUnits: zero, riskBudgetBaseUnits: riskBudget, sizeByStopBaseUnits: zero, binding: 'RISK_BUDGET_BY_STOP', caps: emptyCaps(), unknownCapacity: null };
  }
  const sizeByStop = mulDiv(riskBudget, MICRO, BigInt(Math.round(input.stopDistanceFraction * 1_000_000)), 'FLOOR');

  let unknownCapacity: SizingResult['unknownCapacity'] = null;
  let cohort: Amount | null = input.cohortRemainingBaseUnits;
  let cluster: Amount | null = input.clusterRemainingBaseUnits;
  if (input.policy.requireCohortCapacity) {
    if (cohort === null) {
      unknownCapacity = 'COHORT';
      cohort = zero;
    } else if (cluster === null) {
      unknownCapacity = 'CLUSTER';
      cluster = zero;
    }
  }
  const caps: SizingResult['caps'] = {
    RISK_BUDGET_BY_STOP: sizeByStop,
    SLEEVE_CAP: input.sleeve?.capRemainingBaseUnits ?? null,
    MAX_POSITION_VALUE: input.policy.maxPositionValueBaseUnits,
    COHORT_REMAINING: cohort,
    CLUSTER_REMAINING: cluster,
    LIQUIDITY_CAP: input.liquidityBaseUnits === null ? zero : fraction(input.liquidityBaseUnits, input.policy.liquidityCapFraction),
    AVAILABLE_CAPITAL: input.availableCapitalBaseUnits,
  };
  let size = amountToBigInt(sizeByStop);
  let binding: SizingConstraint = 'RISK_BUDGET_BY_STOP';
  for (const [name, cap] of Object.entries(caps) as [Exclude<SizingConstraint, 'NONE'>, Amount | null][]) {
    if (cap === null || name === 'RISK_BUDGET_BY_STOP') continue;
    const c = amountToBigInt(cap);
    if (c < size) {
      size = c;
      binding = name;
    }
  }
  return { sizeBaseUnits: bigIntToAmount(size), riskBudgetBaseUnits: riskBudget, sizeByStopBaseUnits: sizeByStop, binding, caps, unknownCapacity };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function emptyCaps(): SizingResult['caps'] {
  return { RISK_BUDGET_BY_STOP: null, SLEEVE_CAP: null, MAX_POSITION_VALUE: null, COHORT_REMAINING: null, CLUSTER_REMAINING: null, LIQUIDITY_CAP: null, AVAILABLE_CAPITAL: null };
}
