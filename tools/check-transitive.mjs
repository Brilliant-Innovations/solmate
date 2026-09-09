#!/usr/bin/env node
/**
 * Transitive forbidden-package policy and SBOM from the pnpm lockfile (GUARDRAILS.md Part 4;
 * blueprint §24.8 "container/image/SBOM scan verifies forbidden packages are absent from final
 * artifacts, including transitive dependencies where policy marks them forbidden"; plan M11).
 *
 * The source-level boundary lint stops a banned import from being written and the built-artifact
 * scan (tools/check-artifacts.mjs) looks at what was bundled. This check closes the remaining gap:
 * the full production dependency closure each deployable *could* load — every package reachable
 * from its package.json dependencies through the lockfile, following workspace links — must not
 * contain a package the deployable's trust level forbids, whether or not the bundler happened to
 * inline it. The same closure is emitted as a CycloneDX 1.5 SBOM per deployable so the artifact
 * can be audited outside this repository.
 *
 * Only production dependencies count (devDependencies are build and test tooling that never ships).
 *
 * Usage:
 *   node tools/check-transitive.mjs                         # every deployable, SBOMs to dist/sbom/
 *   node tools/check-transitive.mjs --service worker        # one deployable (repeatable)
 *   node tools/check-transitive.mjs --lockfile x.yaml --no-sbom   # arbitrary lockfile (CI negative test)
 *
 * Exit code 1 on any forbidden package in a closure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_STACK, DEX_SDKS, LLM_SDKS, PROVIDER_CLIENTS, SIGNER_SDKS, WALLET_STANDARD } from './forbidden-packages.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Forbidden package families per deployable (GUARDRAILS.md Part 4 "External package bans by trust level"). */
export const TRANSITIVE_POLICY = {
  'risk-authorizer': { importer: 'apps/risk-authorizer', banned: [...LLM_SDKS, ...SIGNER_SDKS, ...DEX_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS] },
  'execution-service': { importer: 'apps/execution-service', banned: [...LLM_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS] },
  worker: { importer: 'apps/worker', banned: [...SIGNER_SDKS] },
  web: { importer: 'apps/web', banned: [...SIGNER_SDKS, ...DEX_SDKS] },
};

// --- minimal pnpm-lock.yaml reader ---------------------------------------------------------------
// The lockfile is regular block YAML: maps keyed by (possibly quoted) strings, scalar values,
// `{}` empty maps and `- item` lists. That subset is all the reader needs; anything else is an error.

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Splits `key: value` at the first `: ` outside quotes. */
function splitKey(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === "'" || ch === '"') inQuote = ch;
    else if (ch === ':' && (i === line.length - 1 || line[i + 1] === ' ')) return [line.slice(0, i), line.slice(i + 1).trim()];
  }
  return [line, ''];
}

export function parseLockfile(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (line.startsWith('- ')) {
      if (!Array.isArray(parent.__list)) parent.__list = [];
      parent.__list.push(unquote(line.slice(2)));
      continue;
    }
    const [k, v] = splitKey(line);
    const key = unquote(k);
    if (v === '' ) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else if (v === '{}') parent[key] = {};
    else if (v.startsWith('{')) {
      // inline map, e.g. resolution: {integrity: sha512-…}
      const inner = {};
      for (const part of v.slice(1, -1).split(',')) {
        const [ik, iv] = splitKey(part.trim());
        if (ik) inner[unquote(ik)] = unquote(iv);
      }
      parent[key] = inner;
    } else parent[key] = unquote(v);
  }
  return root;
}

/** `name@version(peers)` → { name, version, spec } where spec keeps the peer suffix for snapshot lookup. */
export function splitSpec(spec) {
  const at = spec.indexOf('@', 1);
  const name = spec.slice(0, at);
  const rest = spec.slice(at + 1);
  const paren = rest.indexOf('(');
  return { name, version: paren >= 0 ? rest.slice(0, paren) : rest, spec };
}

function patternToRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/**
 * Production closure of one importer: every non-workspace package reachable through dependencies
 * and optionalDependencies, following `link:` entries to other importers. Returns a map
 * `name@version` → { name, version, integrity, via: [chain of package names from the importer] }.
 */
export function closureOf(lock, importerPath) {
  const importers = lock.importers ?? {};
  const snapshots = lock.snapshots ?? {};
  const packages = lock.packages ?? {};
  const out = new Map();
  const seenImporters = new Set();
  const visitSnapshot = (spec, chain) => {
    const { name, version } = splitSpec(spec);
    const id = `${name}@${version}`;
    if (out.has(id)) return;
    const pkg = packages[id] ?? {};
    out.set(id, { name, version, integrity: pkg.resolution?.integrity ?? null, via: chain });
    const snap = snapshots[spec] ?? snapshots[id] ?? {};
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [depName, depVersion] of Object.entries(snap[section] ?? {})) {
        if (typeof depVersion !== 'string') continue;
        if (depVersion.startsWith('link:')) continue;
        visitSnapshot(`${depName}@${depVersion}`, [...chain, name]);
      }
    }
  };
  const visitImporter = (path, chain) => {
    if (seenImporters.has(path)) return;
    seenImporters.add(path);
    const imp = importers[path];
    if (!imp) throw new Error(`lockfile has no importer ${path}`);
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [depName, entry] of Object.entries(imp[section] ?? {})) {
        const version = typeof entry === 'string' ? entry : entry.version;
        if (typeof version !== 'string') continue;
        if (version.startsWith('link:')) visitImporter(posix.normalize(posix.join(path, version.slice(5))), [...chain, depName]);
        else visitSnapshot(`${depName}@${version}`, chain);
      }
    }
  };
  visitImporter(importerPath, []);
  return out;
}

export function violations(closure, banned) {
  const rules = banned.map((p) => ({ pattern: p, re: patternToRegex(p) }));
  const found = [];
  for (const entry of closure.values()) {
    const hit = rules.find((r) => r.re.test(entry.name));
    if (hit) found.push({ package: `${entry.name}@${entry.version}`, pattern: hit.pattern, via: entry.via });
  }
  return found.sort((a, b) => a.package.localeCompare(b.package));
}

export function sbomOf(service, closure, version) {
  const components = [...closure.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).map((c) => ({
    type: 'library',
    'bom-ref': `pkg:npm/${c.name}@${c.version}`,
    name: c.name,
    version: c.version,
    purl: `pkg:npm/${c.name}@${c.version}`,
    ...(c.integrity ? { hashes: [{ alg: c.integrity.startsWith('sha512-') ? 'SHA-512' : 'SHA-256', content: Buffer.from(c.integrity.slice(c.integrity.indexOf('-') + 1), 'base64').toString('hex') }] } : {}),
  }));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: `@sol-agent-trader/${service}`, version, 'bom-ref': `app:${service}` }, tools: [{ name: 'check-transitive.mjs', vendor: 'sol-agent-trader' }] },
    components,
    dependencies: [{ ref: `app:${service}`, dependsOn: components.map((c) => c['bom-ref']) }],
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const services = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--service') services.push(args[i + 1]);
  const lockPath = resolve(ROOT, arg('--lockfile') ?? 'pnpm-lock.yaml');
  const sbomDir = args.includes('--no-sbom') ? null : resolve(ROOT, arg('--sbom-dir') ?? 'dist/sbom');
  const lock = parseLockfile(readFileSync(lockPath, 'utf8'));
  const targets = services.length ? services : Object.keys(TRANSITIVE_POLICY);
  let failed = false;
  for (const service of targets) {
    const policy = TRANSITIVE_POLICY[service];
    if (!policy) {
      console.error(JSON.stringify({ check: 'transitive', service, ok: false, error: 'unknown service' }));
      failed = true;
      continue;
    }
    const closure = closureOf(lock, policy.importer);
    const found = violations(closure, policy.banned);
    let version = '0.0.0';
    const pkgJson = resolve(ROOT, policy.importer, 'package.json');
    if (existsSync(pkgJson) && lockPath === resolve(ROOT, 'pnpm-lock.yaml')) version = JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? version;
    if (sbomDir) {
      mkdirSync(sbomDir, { recursive: true });
      writeFileSync(resolve(sbomDir, `${service}.cdx.json`), JSON.stringify(sbomOf(service, closure, version), null, 2) + '\n');
    }
    console.log(JSON.stringify({ check: 'transitive', service, importer: policy.importer, packages: closure.size, bannedPatterns: policy.banned.length, violations: found.length, sbom: sbomDir ? posix.join(posix.relative(ROOT.replace(/\\/g, '/'), sbomDir.replace(/\\/g, '/')), `${service}.cdx.json`) : null, ok: found.length === 0 }));
    for (const v of found) {
      console.error(JSON.stringify({ check: 'transitive', service, forbidden: v.package, pattern: v.pattern, via: [policy.importer, ...v.via].join(' -> ') }));
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

