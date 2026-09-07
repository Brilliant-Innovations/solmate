import type { Instant, MarketSession } from '@sol-agent-trader/contracts';

/**
 * Global market-session labels (blueprint D62, §6.8). Research features, never assumed alpha:
 * recorded on every feature snapshot so §30 can test whether session effects survive fees and
 * regime controls. UTC hour windows: Asia 00–09, Europe 07–16, US 13–22; overlaps where two
 * windows coincide; WEEKEND on Saturday/Sunday UTC in addition to the hour labels.
 */
export function marketSessionsAt(at: Instant): MarketSession[] {
  const d = new Date(at);
  const h = d.getUTCHours();
  const asia = h >= 0 && h < 9;
  const europe = h >= 7 && h < 16;
  const us = h >= 13 && h < 22;
  const out: MarketSession[] = [];
  if (asia) out.push('ASIA');
  if (europe) out.push('EUROPE');
  if (us) out.push('US');
  if (asia && europe) out.push('ASIA_EUROPE_OVERLAP');
  if (europe && us) out.push('EUROPE_US_OVERLAP');
  const day = d.getUTCDay();
  if (day === 0 || day === 6) out.push('WEEKEND');
  return out;
}
