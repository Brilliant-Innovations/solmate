import { z } from 'zod';
import * as primitives from '../primitives.js';
import * as enums from '../enums.js';
import * as entities from '../entities/index.js';
import * as envelopes from '../envelopes/index.js';
import * as config from '../config/index.js';
import * as realtime from '../realtime.js';
import * as policy from '../policy/index.js';
import { SignedEnvelopeMeta } from '../signing/signed-envelope.js';

/**
 * Every exported Zod schema in the contracts library, keyed by a stable `group.Name` id.
 * The registry is discovered from the module namespaces so a schema cannot be added to the
 * library without becoming part of the contract-set digest (D50).
 */
export type ContractRegistry = ReadonlyMap<string, z.ZodType>;

function collect(prefix: string, ns: Record<string, unknown>, into: Map<string, z.ZodType>): void {
  for (const name of Object.keys(ns).sort()) {
    const value = ns[name];
    if (value instanceof z.ZodType) into.set(`${prefix}.${name}`, value);
  }
}

export function buildContractRegistry(): ContractRegistry {
  const map = new Map<string, z.ZodType>();
  collect('primitives', primitives, map);
  collect('enums', enums, map);
  collect('entities', entities, map);
  collect('envelopes', envelopes, map);
  collect('config', config, map);
  collect('realtime', realtime, map);
  collect('policy', policy, map);
  collect('signing', { SignedEnvelopeMeta }, map);
  return map;
}

export const contractRegistry: ContractRegistry = buildContractRegistry();
