import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonicalize } from '../signing/canonical.js';
import { fixtureCatalog } from '../fixtures/index.js';
import { computeContractSetDigest, getContractSetDigest, schemaToJsonSchema } from './contract-set-digest.js';
import { buildContractRegistry, contractRegistry } from './registry.js';

const LOCK_PATH = resolve(import.meta.dirname, '../../contract-set.lock.json');

describe('contract registry', () => {
  it('discovers every exported schema and is deterministic', () => {
    const again = buildContractRegistry();
    expect([...again.keys()]).toEqual([...contractRegistry.keys()]);
    expect(contractRegistry.size).toBeGreaterThan(100);
    for (const name of ['entities.TradeIntent', 'envelopes.RiskAuthorizedIntent', 'primitives.Amount', 'enums.CapitalAuthority']) {
      expect(contractRegistry.has(name)).toBe(true);
    }
  });

  it('every registered schema is JSON-Schema representable', () => {
    for (const [name, schema] of contractRegistry) {
      expect(() => canonicalize(schemaToJsonSchema(schema)), name).not.toThrow();
    }
  });
});

describe('contract-set digest (INV-24)', () => {
  it('is stable across recomputation and memoized', async () => {
    const a = await computeContractSetDigest();
    const b = await computeContractSetDigest();
    expect(a.digest).toBe(b.digest);
    expect(a.schemaCount).toBe(contractRegistry.size);
    expect((await getContractSetDigest()).digest).toBe(a.digest);
  });

  it('changes when any schema changes', async () => {
    const base = await computeContractSetDigest();
    const mutated = new Map(contractRegistry);
    mutated.set('entities.TradeIntent', z.object({ id: z.string() }));
    expect((await computeContractSetDigest(mutated)).digest).not.toBe(base.digest);
    const added = new Map(contractRegistry);
    added.set('entities.Extra', z.object({}));
    expect((await computeContractSetDigest(added)).digest).not.toBe(base.digest);
  });

  it('matches contract-set.lock.json (run with UPDATE_CONTRACT_LOCK=1 to accept a deliberate change)', async () => {
    const report = await computeContractSetDigest();
    const next = { format: report.format, digest: report.digest, schemaCount: report.schemaCount };
    if (process.env['UPDATE_CONTRACT_LOCK'] === '1') {
      writeFileSync(LOCK_PATH, JSON.stringify(next, null, 2) + '\n');
    }
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as typeof next;
    expect(lock, 'contract set changed: review the diff, then UPDATE_CONTRACT_LOCK=1 to accept').toEqual(next);
  });
});

describe('cross-boundary encode/decode (INV-24)', () => {
  it.each(fixtureCatalog().map((f) => [f.name, f] as const))('%s survives a JSON round trip with semantic equality', (_n, f) => {
    const encoded = JSON.stringify(f.value);
    const decoded = f.schema.parse(JSON.parse(encoded));
    expect(canonicalize(decoded)).toBe(canonicalize(f.value));
    // parsing the decoded value again is a fixed point
    expect(canonicalize(f.schema.parse(decoded))).toBe(canonicalize(decoded));
  });

  it('signed payload schemas are strict: an unknown key is rejected rather than silently stripped', () => {
    for (const f of fixtureCatalog().filter((x) => x.name.startsWith('envelopes.'))) {
      const withExtra = { ...(f.value as Record<string, unknown>), __injected: 1 };
      expect(f.schema.safeParse(withExtra).success, f.name).toBe(false);
    }
  });
});
