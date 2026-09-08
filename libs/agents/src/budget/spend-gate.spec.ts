import fc from 'fast-check';
import { addMs, fixtures, type Instant, type SpendBudget, type SpendUsage, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { evaluateSpendGate } from './spend-gate.js';

const T0 = fixtures.T0 as Instant;
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;

function budget(n: number, scope: SpendBudget['scope'], scopeId: string | null, limits: Partial<SpendBudget['limits']>, active = true): SpendBudget {
  return { id: id(n), versionId: 'budget-v1' as VersionId, scope, scopeId, limits: { cyclesPerHour: null, modelUsdPerDay: null, providerRequestsPerMinute: null, ...limits }, active, createdAt: T0 };
}
function usage(n: number, budgetId: Uuid, v: Partial<Pick<SpendUsage, 'cycles' | 'modelUsd' | 'providerRequests' | 'state'>>, window: [Instant, Instant] = [addMs(T0, -60_000), addMs(T0, 60_000)]): SpendUsage {
  return { id: id(n), budgetId, windowStart: window[0], windowEnd: window[1], cycles: 0, modelUsd: 0, providerRequests: 0, state: 'OK', updatedAt: T0, ...v };
}

describe('spend circuit breakers (D43, §11.7; INV-21 owner module)', () => {
  const platform = budget(1, 'PLATFORM', null, { modelUsdPerDay: 20 });
  const strategy = budget(2, 'STRATEGY', 'S1', { cyclesPerHour: 10, modelUsdPerDay: 5 });
  const other = budget(3, 'STRATEGY', 'S2', { cyclesPerHour: 0 });
  const provider = budget(4, 'PROVIDER', 'anthropic', { providerRequestsPerMinute: 30 });
  const inactive = budget(5, 'PLATFORM', null, { cyclesPerHour: 0 }, false);
  const budgets = [platform, strategy, other, provider, inactive];
  const base = { budgets, strategyId: 'S1', providers: ['anthropic'], now: T0 };

  it('passes with no usage, ignores inactive budgets and budgets for other strategies or providers', () => {
    expect(evaluateSpendGate({ ...base, usage: [] })).toEqual({ ok: true, checked: 3 });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, other.id, { cycles: 99 })] })).toEqual({ ok: true, checked: 3 });
    expect(evaluateSpendGate({ ...base, providers: ['openai'], usage: [usage(11, provider.id, { providerRequests: 999 })] })).toEqual({ ok: true, checked: 2 });
  });

  it('blocks on the first breached limit in platform → strategy → provider order, and on a paused window', () => {
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { cycles: 10 })] })).toMatchObject({ ok: false, block: { code: 'CYCLES_PER_HOUR', budgetId: strategy.id, used: 10, limit: 10 } });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { modelUsd: 5 })] })).toMatchObject({ ok: false, block: { code: 'MODEL_USD_PER_DAY', budgetId: strategy.id } });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, platform.id, { modelUsd: 20 }), usage(11, strategy.id, { cycles: 10 })] })).toMatchObject({ ok: false, block: { code: 'MODEL_USD_PER_DAY', budgetId: platform.id, scope: 'PLATFORM' } });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, provider.id, { providerRequests: 30 })] })).toMatchObject({ ok: false, block: { code: 'PROVIDER_REQUESTS_PER_MINUTE', budgetId: provider.id } });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { state: 'BUDGET_PAUSED' })] })).toMatchObject({ ok: false, block: { code: 'BUDGET_PAUSED', budgetId: strategy.id } });
  });

  it('only a window containing now counts; an expired window is ignored', () => {
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { cycles: 99 }, [addMs(T0, -7_200_000), addMs(T0, -3_600_000)])] })).toEqual({ ok: true, checked: 3 });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { cycles: 99 }, [T0, addMs(T0, 3_600_000)])] })).toMatchObject({ ok: false });
    expect(evaluateSpendGate({ ...base, usage: [usage(10, strategy.id, { cycles: 99 }, [addMs(T0, -3_600_000), T0])] })).toEqual({ ok: true, checked: 3 });
  });

  it('property: usage at or above any applicable non-null limit blocks; strictly below every limit passes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.double({ min: 0, max: 40, noNaN: true }), fc.integer({ min: 0, max: 60 }), (cycles, usd, reqs) => {
        const r = evaluateSpendGate({ ...base, usage: [usage(10, platform.id, { modelUsd: usd }), usage(11, strategy.id, { cycles, modelUsd: usd }), usage(12, provider.id, { providerRequests: reqs })] });
        const shouldBlock = usd >= 20 || cycles >= 10 || usd >= 5 || reqs >= 30;
        expect(r.ok).toBe(!shouldBlock);
      }),
      { numRuns: 300 },
    );
  });
});
