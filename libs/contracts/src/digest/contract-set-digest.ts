import { z } from 'zod';
import { Sha256Hex } from '../primitives.js';
import { canonicalize, sha256Hex } from '../signing/canonical.js';
import { contractRegistry, type ContractRegistry } from './registry.js';

/**
 * Contract-set digest (blueprint D50, §24.8, §29).
 *
 * Every live-capable deployable embeds this digest and reports it at startup and in readiness.
 * Two deployables with different digests may never both be live. The digest is the SHA-256 of
 * the canonical JSON of `{ name: sha256(canonical(fingerprint of schema)) }` over every registered
 * schema. The fingerprint is the JSON Schema plus an `x-zod` annotation on every node carrying the
 * Zod node type, object strictness (catchall) and check kinds/parameters, so strict-vs-loose and
 * refinements, which JSON Schema alone cannot express, still change the digest.
 */

export const CONTRACT_SET_FORMAT = 'zod4-jsonschema-xzod-canonical-sha256-v2' as const;

export interface ContractSetDigestReport {
  format: typeof CONTRACT_SET_FORMAT;
  digest: Sha256Hex;
  schemaCount: number;
  entries: ReadonlyArray<{ name: string; schemaHash: Sha256Hex }>;
}

type ZodInternals = { _zod?: { def?: Record<string, unknown> } };

function describeValue(v: unknown): unknown {
  if (v instanceof RegExp) return { regex: v.source, flags: v.flags };
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (typeof v === 'bigint') return v.toString(10);
  if (v !== null && typeof v === 'object') {
    const def = (v as ZodInternals)._zod?.def;
    if (def) return { zodType: def['type'] };
    if (Array.isArray(v)) return v.map(describeValue);
    return undefined;
  }
  return v;
}

const CHECK_KEYS = ['check', 'minimum', 'maximum', 'inclusive', 'format', 'pattern', 'when', 'abort', 'multipleOf', 'exact', 'length'] as const;

function describeChecks(def: Record<string, unknown>): unknown[] {
  const checks = def['checks'];
  if (!Array.isArray(checks)) return [];
  return checks.map((c) => {
    const d = (c as ZodInternals)._zod?.def ?? {};
    const out: Record<string, unknown> = {};
    for (const k of CHECK_KEYS) if (k in d) out[k] = describeValue(d[k]);
    return out;
  });
}

function annotate(zodSchema: unknown, jsonSchema: Record<string, unknown>): void {
  const def = (zodSchema as ZodInternals)._zod?.def;
  if (!def) return;
  const catchall = def['catchall'] as ZodInternals | undefined;
  jsonSchema['x-zod'] = {
    type: def['type'],
    catchall: catchall?._zod?.def?.['type'] ?? null,
    checks: describeChecks(def),
    literal: 'values' in def ? describeValue(def['values']) : undefined,
  };
}

export function schemaToJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, {
    unrepresentable: 'any',
    io: 'output',
    override: (ctx) => annotate(ctx.zodSchema, ctx.jsonSchema as Record<string, unknown>),
  });
}

export async function computeContractSetDigest(registry: ContractRegistry = contractRegistry): Promise<ContractSetDigestReport> {
  const entries: Array<{ name: string; schemaHash: Sha256Hex }> = [];
  for (const [name, schema] of [...registry.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    entries.push({ name, schemaHash: await sha256Hex(canonicalize(schemaToJsonSchema(schema))) });
  }
  const digest = await sha256Hex(
    canonicalize({ format: CONTRACT_SET_FORMAT, entries: Object.fromEntries(entries.map((e) => [e.name, e.schemaHash])) }),
  );
  return { format: CONTRACT_SET_FORMAT, digest, schemaCount: entries.length, entries };
}

let cached: Promise<ContractSetDigestReport> | undefined;

/** Memoized digest of the registry compiled into this process. */
export function getContractSetDigest(): Promise<ContractSetDigestReport> {
  cached ??= computeContractSetDigest();
  return cached;
}
