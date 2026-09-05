#!/usr/bin/env node
// Invariant map checker — execution plan ground rule 2, blueprint §24.6.
//
// Rules:
//   * every invariant has id, statement, owner_modules (>=1), tests, status
//   * status must be "unmapped" or "mapped" (never "waived")
//   * "unmapped" is allowed only while NONE of the owner_modules exists on disk
//   * "mapped" requires >=1 test path and every test path must exist
//   * ids are unique and the count matches the §24.6 list (28)
//
// Zero dependencies: parses the constrained YAML shape used by invariant-test-map.yaml.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapPath = resolve(root, "invariant-test-map.yaml");
const EXPECTED_COUNT = 28;

function parseMap(text) {
  const invariants = [];
  let cur = null;
  let listKey = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let m;
    if ((m = line.match(/^  - id:\s*(\S+)\s*$/))) {
      cur = { id: m[1], owner_modules: [], tests: [] };
      invariants.push(cur);
      listKey = null;
      continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^    (\w+):\s*\[\]\s*$/))) { cur[m[1]] = []; listKey = null; continue; }
    if ((m = line.match(/^    (\w+):\s*$/))) { cur[m[1]] = []; listKey = m[1]; continue; }
    if ((m = line.match(/^    (\w+):\s*(.+)$/))) {
      let v = m[2].trim();
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      cur[m[1]] = v;
      listKey = null;
      continue;
    }
    if ((m = line.match(/^      - (.+)$/)) && listKey) { cur[listKey].push(m[1].trim()); continue; }
    throw new Error(`Unrecognised line in invariant-test-map.yaml: ${JSON.stringify(raw)}`);
  }
  return invariants;
}

const errors = [];
const invariants = parseMap(readFileSync(mapPath, "utf8"));

if (invariants.length !== EXPECTED_COUNT) {
  errors.push(`expected ${EXPECTED_COUNT} invariants (blueprint §24.6), found ${invariants.length}`);
}
const seen = new Set();
for (const inv of invariants) {
  const tag = inv.id ?? "<no id>";
  if (seen.has(inv.id)) errors.push(`${tag}: duplicate id`);
  seen.add(inv.id);
  if (!inv.statement) errors.push(`${tag}: missing statement`);
  if (!Array.isArray(inv.owner_modules) || inv.owner_modules.length === 0) errors.push(`${tag}: owner_modules empty`);
  if (!Array.isArray(inv.tests)) errors.push(`${tag}: tests missing`);
  if (!["unmapped", "mapped"].includes(inv.status)) {
    errors.push(`${tag}: status must be "unmapped" or "mapped" (got ${JSON.stringify(inv.status)})`);
    continue;
  }
  const existingOwners = (inv.owner_modules ?? []).filter((p) => existsSync(resolve(root, p)));
  if (inv.status === "unmapped" && existingOwners.length > 0) {
    errors.push(`${tag}: owning module(s) exist (${existingOwners.join(", ")}) but no executable test is mapped`);
  }
  if (inv.status === "mapped") {
    if (inv.tests.length === 0) errors.push(`${tag}: status mapped but tests is empty`);
    for (const t of inv.tests) {
      if (!existsSync(resolve(root, t))) errors.push(`${tag}: mapped test not found: ${t}`);
    }
  }
}

const mapped = invariants.filter((i) => i.status === "mapped").length;
if (errors.length) {
  console.error(`invariant-test-map: FAIL (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`invariant-test-map: OK — ${invariants.length} invariants, ${mapped} mapped, ${invariants.length - mapped} unmapped (owning modules not yet built)`);
