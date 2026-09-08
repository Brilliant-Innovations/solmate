import { addMs, fixtures, generateSigningKeyPair, signPayload, toInstant, type Amount, type RiskStateProjection, type Sequence, type Sha256Hex, type Slot, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { verifyProjection, type IndependentChainReads, type ProjectionVerifyInput } from './verify.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const T0 = fixtures.T0 as ProjectionVerifyInput['now'];

describe('signed risk-state projection verification (D21, D52, INV-07)', () => {
  it('a pinned-key signature with an advancing sequence, fresh timestamp, matching release and agreeing chain reads is accepted; every tampering path is refused', async () => {
    const projector = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const base: RiskStateProjection = { ...fixtures.riskStateProjection(), asOf: addMs(NOW, -5_000) };
    const chain: IndependentChainReads = { slot: (base.chainSlot + 5) as Slot, settlementBaseUnits: base.settlementAvailableBaseUnits, gasLamports: base.gasReserveLamports, custody: base.custody.map((c) => ({ ...c })) };
    const input = async (p: RiskStateProjection, over: Partial<ProjectionVerifyInput> = {}, key = projector): Promise<ProjectionVerifyInput> => ({
      envelope: await signPayload(p, key, NOW), acceptedKeys: [projector], lastSequence: 41 as Sequence, now: NOW, maxAgeMs: 30_000,
      expected: { releaseId: base.releaseId, releaseDigest: base.releaseDigest, policyVersion: base.policyVersion }, chain, tolerance: { balanceBps: 10, maxSlotLag: 150 }, ...over,
    });
    const ok = await verifyProjection(await input(base));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sequence).toBe(42);

    // DB-only tampering: edit the payload after signing → hash mismatch; re-sign with a key that is not pinned → unknown key
    const edited = await input(base);
    edited.envelope = { ...edited.envelope, payload: { ...edited.envelope.payload, settlementAvailableBaseUnits: '9000000000' as Amount } };
    const t1 = await verifyProjection(edited);
    expect(t1.ok).toBe(false);
    if (!t1.ok) expect(t1.reasons).toEqual(['PROJECTION_SIGNATURE_INVALID']);
    const t2 = await verifyProjection(await input({ ...base, settlementAvailableBaseUnits: '9000000000' as Amount }, {}, other));
    expect(t2.ok).toBe(false);
    if (!t2.ok) expect(t2.detail).toEqual(['UNKNOWN_KEY']);

    const cases: [RiskStateProjection, Partial<ProjectionVerifyInput>, string][] = [
      [{ ...base, sequence: 41 as Sequence }, {}, 'PROJECTION_SEQUENCE_ROLLBACK'],
      [{ ...base, asOf: addMs(NOW, -60_000) }, {}, 'PROJECTION_STALE'],
      [{ ...base, releaseDigest: 'ee'.repeat(32) as Sha256Hex }, {}, 'PROJECTION_RELEASE_MISMATCH'],
      [{ ...base, policyVersion: 'risk@9' as VersionId }, {}, 'PROJECTION_POLICY_MISMATCH'],
      // a wider settlement balance than chain shows is exactly the D52 attack
      [{ ...base, settlementAvailableBaseUnits: '5100000000' as Amount }, {}, 'CHAIN_SETTLEMENT_DISAGREES'],
      [{ ...base, gasReserveLamports: '300000000' as Amount }, {}, 'CHAIN_GAS_DISAGREES'],
      [{ ...base, custody: [{ ...base.custody[0]!, amount: '6000000000' as Amount }] }, {}, 'CHAIN_CUSTODY_DISAGREES'],
      [{ ...base, custody: [{ custodyAccountId: fixtures.IDS.lot as Uuid, mint: base.settlementMint, amount: '1' as Amount }] }, {}, 'CHAIN_CUSTODY_DISAGREES'],
      [{ ...base, chainSlot: (base.chainSlot - 1000) as Slot }, {}, 'CHAIN_SLOT_BEHIND'],
    ];
    for (const [p, over, reason] of cases) {
      const v = await verifyProjection(await input(p, over));
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
    // claiming less than chain is conservative and fine; a first use has no previous sequence
    const less = await verifyProjection(await input({ ...base, settlementAvailableBaseUnits: '4000000000' as Amount }, { lastSequence: null }));
    expect(less.ok).toBe(true);
    // paper authority may verify without chain reads
    const noChain = await verifyProjection(await input(base, { chain: null }));
    expect(noChain.ok).toBe(true);
    void T0;
  });
});
