import type { SignatureStatus } from './observer.js';
import { proveDeadAcrossViews, quorumVerdict, readSignature, type QuorumObserver, type ViewReading } from './quorum.js';

const SIG = 'sig-1';
class View implements QuorumObserver {
  constructor(readonly label: string, private status: SignatureStatus | null | Error, private head: number, private height = 100) {}
  async signatureStatus(): Promise<SignatureStatus | null> { if (this.status instanceof Error) throw this.status; return this.status; }
  async blockHeight(): Promise<number> { return this.height; }
  async headSlot(): Promise<number> { return this.head; }
}
const landed = (slot: number, c: SignatureStatus['confirmationStatus'] = 'confirmed'): SignatureStatus => ({ slot, confirmationStatus: c, err: null });
const failed = (slot: number): SignatureStatus => ({ slot, confirmationStatus: 'confirmed', err: { InstructionError: [2, 'Custom'] } });
const read = (views: QuorumObserver[]) => readSignature(views, SIG);

describe('signature quorum across independent RPC views (§14.7, §24.4)', () => {
  it('all views finalized is FINALIZED; mixed confirmed/finalized is CONFIRMED at the transaction slot', async () => {
    expect(quorumVerdict(await read([new View('a', landed(50, 'finalized'), 90), new View('b', landed(50, 'finalized'), 92)]), 64)).toMatchObject({ verdict: 'FINALIZED', slot: 50, answered: 2 });
    expect(quorumVerdict(await read([new View('a', landed(50, 'finalized'), 90), new View('b', landed(50, 'confirmed'), 92)]), 64)).toMatchObject({ verdict: 'CONFIRMED', slot: 50 });
    expect(quorumVerdict(await read([new View('a', landed(50, 'processed'), 90)]), 64)).toMatchObject({ verdict: 'PROCESSED' });
  });

  it('a view that is merely behind the transaction slot does not contradict a landed view; one far past it does', async () => {
    const behind = await read([new View('a', landed(50, 'finalized'), 90), new View('b', null, 60)]);
    expect(quorumVerdict(behind, 64)).toMatchObject({ verdict: 'FINALIZED', slot: 50 });
    const past = await read([new View('a', landed(50, 'finalized'), 90), new View('b', null, 50 + 64 + 1)]);
    expect(quorumVerdict(past, 64)).toMatchObject({ verdict: 'DIVERGENT', slot: null });
    const unknownHead = await read([new View('a', landed(50), 90), { label: 'c', signatureStatus: async () => null, blockHeight: async () => 100 } as QuorumObserver]);
    expect(quorumVerdict(unknownHead, 64)).toMatchObject({ verdict: 'CONFIRMED' });
  });

  it('a success/failure split is always DIVERGENT; consistent failure is FAILED; all missing is MISSING; none answering is UNAVAILABLE', async () => {
    expect(quorumVerdict(await read([new View('a', landed(50), 90), new View('b', failed(50), 90)]), 64)).toMatchObject({ verdict: 'DIVERGENT' });
    expect(quorumVerdict(await read([new View('a', failed(50), 90), new View('b', failed(50), 90)]), 64)).toMatchObject({ verdict: 'FAILED', slot: 50 });
    expect(quorumVerdict(await read([new View('a', null, 90), new View('b', null, 90)]), 64)).toMatchObject({ verdict: 'MISSING' });
    const r = quorumVerdict(await read([new View('a', new Error('timeout'), 90), new View('b', new Error('503'), 90)]), 64);
    expect(r).toMatchObject({ verdict: 'UNAVAILABLE', answered: 0 });
    expect(r.readings.map((x: ViewReading) => x.kind)).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    // one silent view does not change what the other says
    expect(quorumVerdict(await read([new View('a', landed(50, 'finalized'), 90), new View('b', new Error('timeout'), 90)]), 64)).toMatchObject({ verdict: 'FINALIZED', answered: 1 });
  });

  it('INV-23 across views: dead only when every view answers, none knows the signature and every block height is past the last valid one', async () => {
    const dead = { blockHeightExpired: true, signatureHistoryEmpty: true };
    expect(await proveDeadAcrossViews([new View('a', null, 90, 120), new View('b', null, 90, 121)], SIG, 110)).toEqual(dead);
    expect(await proveDeadAcrossViews([new View('a', null, 90, 120), new View('b', null, 90, 105)], SIG, 110)).toBeNull();
    expect(await proveDeadAcrossViews([new View('a', null, 90, 120), new View('b', landed(50), 90, 120)], SIG, 110)).toBeNull();
    expect(await proveDeadAcrossViews([new View('a', null, 90, 120), new View('b', new Error('timeout'), 90, 120)], SIG, 110)).toBeNull();
    expect(await proveDeadAcrossViews([new View('a', null, 90, 120)], SIG, null)).toBeNull();
    expect(await proveDeadAcrossViews([], SIG, 110)).toBeNull();
  });
});
