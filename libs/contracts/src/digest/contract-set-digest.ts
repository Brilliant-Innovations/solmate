import { z } from 'zod';
import { Sha256Hex } from '../primitives.js';
import { canonicalize, sha256Hex } from '../signing/canonical.js';
import { contractRegistry, type ContractRegistry } from './registry.js';

/**
 * Contract-set digest (blueprint D50, §24.8, §29).
 *
 * Every live-capable deployable embeds this digest and reports it at startup and in readiness.
 * Two deployables with different digests may never both be live. The digest is the SHA-256 of
 * the canonical JSON of `{ name: sha256(canonical(JSON Schema of schema)) }` over every
 * registered schema, so any change to any wire shape changes it.
 */

export const CONTRACT_SET_FORMAT = 'zod4-jsonschema-canonical-sha256-v1' as const;

export interface ContractSetDigestReport {
  format: typeof CONTRACT_SET_FORMAT;
  digest: Sha256Hex;
  schemaCount: number;
  entries: ReadonlyArray<{ name: string; schemaHash: Sha256Hex }>;
}

export function schemaToJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' });
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
