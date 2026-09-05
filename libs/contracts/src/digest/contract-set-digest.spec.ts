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

  it('every registered schema is fingerprintable', () => {
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

  it('changes when any schema changes, is added, or is removed', async () => {
    const base = await computeContractSetDigest();
    const mutated = new Map(contractRegistry);
    mutated.set('entities.TradeIntent', z.object({ id: z.string() }));
    expect((await computeContractSetDigest(mutated)).digest).not.toBe(base.digest);
    const added = new Map(contractRegistry);
    added.set('entities.Extra', z.object({}));
    expect((await computeContractSetDigest(added)).digest).not.toBe(base.digest);
    const removed = new Map(contractRegistry);
    removed.delete('entities.TradeIntent');
    expect((await computeContractSetDigest(removed)).digest).not.toBe(base.digest);
  });

  it('sees strictness, refinements and check parameters that JSON Schema alone cannot express', async () => {
    const d = async (s: z.ZodType) => (await computeContractSetDigest(new Map([['x', s]]))).digest;
    const loose = z.object({ a: z.string() });
    const strict = z.strictObject({ a: z.string() });
    const refined = z.object({ a: z.string() }).refine(() => true);
    const bounded = z.object({ a: z.string().max(20) });
    const boundedTighter = z.object({ a: z.string().max(10) });
    const results = await Promise.all([loose, strict, refined, bounded, boundedTighter].map(d));
    expect(new Set(results).size).toBe(results.length);
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

/** Every plain-object node in a value, as [path, object] pairs (arrays descended, objects yielded). */
function* objectNodes(value: unknown, path: string[] = []): Generator<[string[], Record<string, unknown>]> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* objectNodes(value[i], [...path, String(i)]);
  } else if (value !== null && typeof value === 'object') {
    yield [path, value as Record<string, unknown>];
    for (const [k, v] of Object.entries(value)) yield* objectNodes(v, [...path, k]);
  }
}

function withInjectedAt(root: unknown, path: string[]): unknown {
  if (path.length === 0) return { ...(root as Record<string, unknown>), __injected: 1 };
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(head)] = withInjectedAt(copy[Number(head)], rest);
    return copy;
  }
  const obj = root as Record<string, unknown>;
  return { ...obj, [head]: withInjectedAt(obj[head], rest) };
}

describe('cross-boundary encode/decode (INV-24)', () => {
  it.each(fixtureCatalog().map((f) => [f.name, f] as const))('%s survives a JSON round trip with semantic equality', (_n, f) => {
    const encoded = JSON.stringify(f.value);
    const decoded = f.schema.parse(JSON.parse(encoded));
    expect(canonicalize(decoded)).toBe(canonicalize(f.value));
    expect(canonicalize(f.schema.parse(decoded))).toBe(canonicalize(decoded));
  });

  /**
   * Deliberately open `JsonRecord` fields. A record keeps every key on parse, so there is no
   * strip-then-rehash ambiguity; they are free-form by design (§15.10 journal payload, §5.4 queue payload).
   */
  const OPEN_RECORD_PATHS: Record<string, string[][]> = {
    'envelopes.ExecutorJournalEntry': [['payload']],
    'envelopes.QueueMessageEnvelope': [['payload']],
  };
  const under = (path: string[], prefix: string[]) => prefix.every((p, i) => path[i] === p);

  it('signed payload schemas are strict at every nesting level: an unknown key anywhere is rejected, never stripped', () => {
    for (const f of fixtureCatalog().filter((x) => x.name.startsWith('envelopes.'))) {
      const open = OPEN_RECORD_PATHS[f.name] ?? [];
      for (const [path] of objectNodes(f.value)) {
        if (open.some((prefix) => under(path, prefix))) continue;
        const tampered = withInjectedAt(f.value, path);
        expect(f.schema.safeParse(tampered).success, `${f.name} at /${path.join('/')}`).toBe(false);
      }
    }
  });

  it('open record fields keep unknown keys intact on parse (no silent stripping, so the hash is unambiguous)', () => {
    for (const [name, paths] of Object.entries(OPEN_RECORD_PATHS)) {
      const f = fixtureCatalog().find((x) => x.name === name);
      expect(f, name).toBeDefined();
      if (!f) continue;
      for (const path of paths) {
        const tampered = withInjectedAt(f.value, path);
        const parsed = f.schema.parse(tampered);
        expect(canonicalize(parsed)).toBe(canonicalize(tampered));
      }
    }
  });
});
