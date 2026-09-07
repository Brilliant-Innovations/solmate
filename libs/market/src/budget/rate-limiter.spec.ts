import { fixedClock, toInstant, type Clock } from '@sol-agent-trader/contracts';
import { ComputeUnitLedger } from './rate-limiter.js';

const SEPT = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const OCT = toInstant(Date.UTC(2026, 9, 1, 0, 0, 1));

describe('compute-unit ledger persistence (§21.1, D43)', () => {
  it('a restored ledger resumes the month instead of resetting; a persisted past month is ignored', () => {
    const ledger = new ComputeUnitLedger(fixedClock(SEPT), 30_000);
    ledger.restore({ month: '2026-09', used: 29_000, byEndpoint: { '/defi/ohlcv': 29_000 } });
    expect(ledger.snapshot()).toMatchObject({ month: '2026-09', used: 29_000, remaining: 1_000 });
    expect(ledger.allows(100, 'NORMAL')).toBe(false);
    expect(ledger.allows(100, 'CRITICAL')).toBe(true);
    const fresh = new ComputeUnitLedger(fixedClock(OCT), 30_000);
    fresh.restore({ month: '2026-09', used: 29_000, byEndpoint: {} });
    expect(fresh.snapshot()).toMatchObject({ month: '2026-10', used: 0 });
    expect(ComputeUnitLedger.monthKeyFor(Date.parse(OCT))).toBe('2026-10');
  });

  it('every charge reaches the sink with the running total, and a month rollover starts from zero', () => {
    let nowMs = Date.parse(SEPT);
    const clock: Clock = { now: () => toInstant(nowMs), nowMs: () => nowMs };
    const ledger = new ComputeUnitLedger(clock, 30_000);
    const seen: { month: string; endpoint: string; cu: number; usedAfter: number }[] = [];
    ledger.onCharge((c) => seen.push(c));
    ledger.charge('/defi/token_overview', 15);
    ledger.charge('/defi/token_overview', 15);
    ledger.charge('/defi/ohlcv', 45);
    expect(seen).toEqual([
      { month: '2026-09', endpoint: '/defi/token_overview', cu: 15, usedAfter: 15 },
      { month: '2026-09', endpoint: '/defi/token_overview', cu: 15, usedAfter: 30 },
      { month: '2026-09', endpoint: '/defi/ohlcv', cu: 45, usedAfter: 75 },
    ]);
    nowMs = Date.parse(OCT);
    ledger.charge('/defi/ohlcv', 45);
    expect(seen.at(-1)).toEqual({ month: '2026-10', endpoint: '/defi/ohlcv', cu: 45, usedAfter: 45 });
    ledger.onCharge(null);
    ledger.charge('/defi/ohlcv', 1);
    expect(seen).toHaveLength(4);
  });
});
