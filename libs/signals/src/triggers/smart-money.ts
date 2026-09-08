import type { FeatureSnapshot, SmartMoneyTriggerPolicy } from '@sol-agent-trader/contracts';

/**
 * Smart-money accumulation trigger (blueprint §9.3, §18.3, D26): several independently
 * high-quality wallets buying, not dominated by one wallet, with market structure confirming
 * rather than contradicting. Own-wallet activity is excluded upstream (the flow facts come from a
 * query that never counts owned wallets), so our own fills can never be smart money here (INV-11).
 */

export interface SmartMoneyFlowFacts {
  /** Net quote-asset flow of tracked wallets into the asset per window, settlement USD. */
  netFlowUsd: { h1: number | null; h4: number | null; h24: number | null };
  distinctBuyers: { h1: number; h4: number; h24: number };
  distinctSellers: { h1: number; h4: number; h24: number };
  /** Share of the 4h buy flow from the single largest buyer, when known. */
  topBuyerShare: number | null;
  ownWalletActivityExcluded: true;
}

export type SmartMoneyCondition = 'INDEPENDENT_BUYERS' | 'NET_ACCUMULATION' | 'NOT_DOMINATED' | 'BUYERS_OUTNUMBER_SELLERS' | 'STRUCTURE_CONFIRMS' | 'LIQUIDITY';

export interface SmartMoneyEvaluation {
  fires: boolean;
  score: number;
  passed: SmartMoneyCondition[];
  failed: { condition: SmartMoneyCondition; reason: 'ABSENT' | 'BELOW_MIN' | 'ABOVE_MAX' | 'FEATURE_COLD'; value: number | null; threshold: number }[];
  inputs: Record<string, number | null>;
}

export function evaluateSmartMoneyTrigger(flow: SmartMoneyFlowFacts, snapshot: Pick<FeatureSnapshot, 'features'>, policy: SmartMoneyTriggerPolicy): SmartMoneyEvaluation {
  const passed: SmartMoneyCondition[] = [];
  const failed: SmartMoneyEvaluation['failed'] = [];
  const f = snapshot.features;
  const g = (name: string): number | null => (typeof f[name] === 'number' && Number.isFinite(f[name]) ? (f[name] as number) : null);
  const buyers = flow.distinctBuyers.h4;
  const sellers = flow.distinctSellers.h4;
  const net = flow.netFlowUsd.h4;
  const inputs: SmartMoneyEvaluation['inputs'] = { buyers_4h: buyers, sellers_4h: sellers, net_flow_usd_4h: net, top_buyer_share: flow.topBuyerShare, ema_9_over_21: g('ema_9_over_21'), ret_1h: g('ret_1h'), liquidity_usd: g('liquidity_usd') };
  if (buyers >= policy.minDistinctBuyers4h) passed.push('INDEPENDENT_BUYERS');
  else failed.push({ condition: 'INDEPENDENT_BUYERS', reason: 'BELOW_MIN', value: buyers, threshold: policy.minDistinctBuyers4h });
  if (net === null) failed.push({ condition: 'NET_ACCUMULATION', reason: 'ABSENT', value: null, threshold: policy.minNetFlowUsd4h });
  else if (net >= policy.minNetFlowUsd4h) passed.push('NET_ACCUMULATION');
  else failed.push({ condition: 'NET_ACCUMULATION', reason: 'BELOW_MIN', value: net, threshold: policy.minNetFlowUsd4h });
  if (flow.topBuyerShare === null) passed.push('NOT_DOMINATED'); // unknown concentration is not evidence of domination; the adversary weighs it
  else if (flow.topBuyerShare <= policy.maxTopBuyerShare) passed.push('NOT_DOMINATED');
  else failed.push({ condition: 'NOT_DOMINATED', reason: 'ABOVE_MAX', value: flow.topBuyerShare, threshold: policy.maxTopBuyerShare });
  if (buyers > sellers * policy.minBuyerSellerRatio) passed.push('BUYERS_OUTNUMBER_SELLERS');
  else failed.push({ condition: 'BUYERS_OUTNUMBER_SELLERS', reason: 'BELOW_MIN', value: sellers === 0 ? buyers : buyers / sellers, threshold: policy.minBuyerSellerRatio });
  const ema = g('ema_9_over_21');
  if (ema === null) failed.push({ condition: 'STRUCTURE_CONFIRMS', reason: 'FEATURE_COLD', value: null, threshold: policy.minEma9Over21 });
  else if (ema >= policy.minEma9Over21) passed.push('STRUCTURE_CONFIRMS');
  else failed.push({ condition: 'STRUCTURE_CONFIRMS', reason: 'BELOW_MIN', value: ema, threshold: policy.minEma9Over21 });
  const liq = g('liquidity_usd');
  if (liq === null) failed.push({ condition: 'LIQUIDITY', reason: 'FEATURE_COLD', value: null, threshold: policy.minLiquidityUsd });
  else if (liq >= policy.minLiquidityUsd) passed.push('LIQUIDITY');
  else failed.push({ condition: 'LIQUIDITY', reason: 'BELOW_MIN', value: liq, threshold: policy.minLiquidityUsd });
  const total = passed.length + failed.length;
  const buyerBonus = Math.min(20, Math.max(0, buyers - policy.minDistinctBuyers4h) * 4);
  const score = Math.max(0, Math.min(100, Math.round((passed.length / total) * 80 + buyerBonus)));
  return { fires: failed.length === 0 && score >= policy.minScannerScore, score, passed, failed, inputs };
}
