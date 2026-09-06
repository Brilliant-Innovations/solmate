#!/usr/bin/env node
/**
 * Extracts `contractSetDigest` from a service's startup log (one JSON object per line) and prints
 * it. Used by .github/workflows/images.yml to prove every image reports the locked digest (D50),
 * and by the Profile 0 launch to compare running containers.
 *
 *   node tools/startup-digest.mjs startup.log
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: startup-digest.mjs <log-file>');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((o) => o && typeof o === 'object');

const startup = lines.find((o) => typeof o.contractSetDigest === 'string');
if (!startup) {
  console.error('no JSON log line carrying contractSetDigest');
  process.exit(1);
}
console.log(startup.contractSetDigest);
