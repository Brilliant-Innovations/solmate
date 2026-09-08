import { DEFAULT_AUTOMATION_SET, StrategyVersion, TRADING_SKILL_VERSION_ID, fixtures, type Instant } from '@sol-agent-trader/contracts';
import { LLM_STRATEGY_SPECS, llmStrategyVersions } from './llm-versions.js';
import { s1StrategyVersion } from './versions.js';

const T0 = fixtures.T0 as Instant;
const models = { proposer: 'anthropic:claude-sonnet-5', adversary: 'openai:gpt-5' };

describe('S1–S4 strategy versions (§12.1, §11.1, D7, D30)', () => {
  it('produces four valid, immutable-by-construction versions bound to Trading Skill v1, distinct ids, PAPER only, adversary required', () => {
    const versions = llmStrategyVersions('abcdef1', T0, models);
    expect(versions.map((v) => v.strategyId)).toEqual(['S1', 'S2', 'S3', 'S4']);
    for (const v of versions) {
      expect(() => StrategyVersion.parse(v)).not.toThrow();
      expect(v.skillVersionId).toBe(TRADING_SKILL_VERSION_ID);
      expect(v.guidelineVersionId).toBe('guide-v1');
      expect(v.automationSetVersionId).toBe(DEFAULT_AUTOMATION_SET.version);
      expect(v.adversaryPolicy).toEqual({ proposerModel: models.proposer, adversaryModel: models.adversary, deterministicGate: false });
      expect(v.eligibleCapitalAuthorities).toEqual(['OBSERVE', 'PAPER']);
      expect(v.status).toBe('PAPER');
      expect(v.allowedActionTypes).not.toContain('ADD');
    }
    expect(new Set(versions.map((v) => v.id)).size).toBe(4);
    expect(new Set(versions.map((v) => v.versionId)).size).toBe(4);
  });

  it('pins each strategy to its family, tier and trigger policy; only S2 carries an event-window policy', () => {
    const byId = Object.fromEntries(llmStrategyVersions('abcdef1', T0, models).map((v) => [v.strategyId, v]));
    expect(byId['S1']?.thresholds).toMatchObject({ families: ['MOMENTUM_CONTINUATION'], triggers: { MOMENTUM_CONTINUATION: 'momentum-v1' } });
    expect(byId['S2']).toMatchObject({ speedTier: 'T3_CATALYST', maxDecisionLatencyMs: 300_000, eventWindowPolicy: { maxDurationMs: 4 * 3_600_000, maxExtensions: 1, requireRetestAfterMs: 15 * 60_000 } });
    expect(byId['S2']?.thresholds).toMatchObject({ families: ['CATALYST_RESPONSE'], triggers: { CATALYST_RESPONSE: 'catalyst-v1', eventWindow: 'event-window-v1' } });
    expect(byId['S3']?.thresholds).toMatchObject({ families: ['SMART_MONEY_ACCUMULATION'], triggers: { SMART_MONEY_ACCUMULATION: 'smart-money-v1' } });
    expect(byId['S4']?.thresholds).toMatchObject({ families: ['HOLDER_LIQUIDITY_EXPANSION'], triggers: { HYBRID: 'hybrid-v1' } });
    for (const id of ['S1', 'S3', 'S4']) expect(byId[id]?.eventWindowPolicy).toEqual({ maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null });
    expect(LLM_STRATEGY_SPECS.map((s) => s.maxCandidateAgeMs)).toEqual([20 * 60_000, 45 * 60_000, 45 * 60_000, 30 * 60_000]);
  });

  it('the S1 builder and the generic builder agree on S1', () => {
    const a = s1StrategyVersion('abcdef1', T0, models);
    const b = llmStrategyVersions('abcdef1', T0, models)[0]!;
    expect(b.id).toBe(a.id);
    expect(b.versionId).toBe(a.versionId);
    expect(b.speedTier).toBe(a.speedTier);
    expect(b.skillVersionId).toBe(a.skillVersionId);
    expect(b.maxDecisionLatencyMs).toBe(a.maxDecisionLatencyMs);
  });
});
