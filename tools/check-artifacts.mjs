#!/usr/bin/env node
/**
 * Forbidden-package scan on built artifacts (GUARDRAILS.md Part 4; blueprint D50, §24.8).
 *
 * Source-level lint stops a banned import from being written. This check looks at what was
 * actually built, so a transitive dependency, a generated file or a mis-tagged project cannot
 * smuggle an LLM SDK, a signer SDK, a DEX SDK or browser code into a financial deployable.
 *
 * Per bundle:
 *   1. Liveness canary: the bundle must carry esbuild's module-path comments (`// node_modules/…`
 *      and `// …/libs/contracts/…`) and the Nx build must not minify, otherwise the scan would be
 *      blind and says so instead of passing (review R2-03).
 *   2. No banned package marker for the service's trust level appears anywhere in the bundle
 *      (module-path comments, pnpm store paths, or literal require/import specifiers).
 *   3. Isolated services (risk-authorizer, execution-service) carry only packages on the
 *      checked-in allowlist (tools/artifact-allowlist.json): every `.pnpm/<pkg>@` package found in
 *      the bundle must be listed. Adding a package there is a reviewed change.
 *   4. Self-contained: every literal `require("x")` / `__require("x")` names a Node built-in, and
 *      no dynamic `require(<expr>)` exists.
 *
 * Usage:
 *   node tools/check-artifacts.mjs                       # every service, apps/<service>/dist/main.js
 *   node tools/check-artifacts.mjs --service worker      # one service (repeatable)
 *   node tools/check-artifacts.mjs --file x.js --policy risk-authorizer   # arbitrary file (CI negative test)
 *   node tools/check-artifacts.mjs --write-allowlist     # regenerate the allowlist from current bundles (reviewed change)
 *
 * Exit code 1 on any finding.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { BROWSER_STACK, DEX_SDKS, LLM_SDKS, PROVIDER_CLIENTS, SIGNER_SDKS, WALLET_STANDARD } from './forbidden-packages.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const ALLOWLIST_PATH = resolve(ROOT, 'tools', 'artifact-allowlist.json');

/** @type {Record<string, string[]>} */
export const POLICY = {
  'risk-authorizer': [...LLM_SDKS, ...SIGNER_SDKS, ...DEX_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS],
  'execution-service': [...LLM_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS],
  worker: [...SIGNER_SDKS],
};

/** Services whose bundles must contain only allowlisted third-party packages. */
export const ALLOWLISTED_SERVICES = ['risk-authorizer', 'execution-service'];

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Regexes that recognise one package pattern in bundle text. `*` matches zero or more name characters. */
function markerRegexes(pattern) {
  const seg = '[^/"\'\\s@]*';
  const pkg = escapeRe(pattern).replaceAll('*', seg);
  // pnpm store folders encode `@scope/name@version` as `@scope+name@version`.
  const pnpmFolder = escapeRe(pattern).replace('/', '\\+').replaceAll('*', seg);
  return [
    new RegExp(`node_modules/${pkg}/`, 'g'),
    new RegExp(`\\.pnpm/${pnpmFolder}@`, 'g'),
    new RegExp(`(?:__)?require\\((["'])${pkg}(?:/[^"']*)?\\1\\)`, 'g'),
    new RegExp(`(?:from|import)\\s*\\(?\\s*(["'])${pkg}(?:/[^"']*)?\\1`, 'g'),
  ];
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Third-party packages present in the bundle, from pnpm store path comments. The name is taken
 * from the `node_modules/<pkg>/` segment after the store folder, not from the folder itself: pnpm
 * truncates long folder names on Windows (`@opentelemetry+sdk-trace-ba_<hash>`), which would
 * otherwise yield names that differ between the developer machine and Linux CI.
 */
export function bundledPackages(text) {
  const found = new Set();
  const re = /\.pnpm\/[^/\s]+\/node_modules\/((?:@[^/\s"']+\/)?[^/\s"']+)\//g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return [...found].sort();
}

/**
 * @returns {{ canary: string[], banned: {pattern: string, line: number, sample: string}[],
 *             notAllowlisted: string[], bareRequires: {specifier: string, line: number}[],
 *             dynamicRequires: {line: number, sample: string}[] }}
 */
export function scanBundle(text, bannedPatterns, allowlist) {
  const canary = [];
  if (!/^\/\/ (?:\.\.\/)*node_modules\//m.test(text)) canary.push('no esbuild module-path comments for node_modules: bundle minified or comments stripped');
  if (!/^\/\/ (?:\.\.\/)*libs\/contracts\//m.test(text)) canary.push('no module-path comment for libs/contracts: not a workspace bundle or comments stripped');

  const banned = [];
  for (const pattern of bannedPatterns) {
    for (const re of markerRegexes(pattern)) {
      let m;
      while ((m = re.exec(text)) !== null) {
        banned.push({ pattern, line: lineOf(text, m.index), sample: m[0].slice(0, 160) });
        if (banned.length > 50) break;
      }
    }
  }

  const notAllowlisted = allowlist ? bundledPackages(text).filter((p) => !allowlist.includes(p)) : [];

  const bareRequires = [];
  const dynamicRequires = [];
  const reqRe = /\b(?:__)?require\(\s*([^)]*?)\s*\)/g;
  let m;
  while ((m = reqRe.exec(text)) !== null) {
    const arg = m[1];
    if (arg === '') continue; // esbuild's `__require()` helper definition
    const lit = /^(["'])([^"'\n]+)\1$/.exec(arg);
    if (!lit) {
      dynamicRequires.push({ line: lineOf(text, m.index), sample: m[0].slice(0, 120) });
      continue;
    }
    const spec = lit[2];
    if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue;
    // Only plausible module specifiers count; log format strings such as "%s" do not.
    if (!/^[@A-Za-z0-9]/.test(spec) || /[\s%]/.test(spec)) continue;
    bareRequires.push({ specifier: spec, line: lineOf(text, m.index) });
  }
  return { canary, banned, notAllowlisted, bareRequires, dynamicRequires };
}

/** The Nx esbuild target must keep module-path comments, in every configuration. */
function buildOptionsFindings(service) {
  const pkgPath = resolve(ROOT, 'apps', service, 'package.json');
  if (!existsSync(pkgPath)) return [`missing ${pkgPath}`];
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const build = pkg?.nx?.targets?.build;
  if (!build) return ['no nx build target'];
  const findings = [];
  const check = (label, opts) => {
    if (!opts) return;
    if (opts.minify === true) findings.push(`${label}: minify=true would strip the comments the scan relies on`);
    const eo = opts.esbuildOptions ?? {};
    if (eo.minify === true || eo.minifyWhitespace === true) findings.push(`${label}: esbuildOptions minify/minifyWhitespace set`);
    if (eo.legalComments === 'none') findings.push(`${label}: esbuildOptions.legalComments=none`);
  };
  check('options', build.options);
  for (const [name, cfg] of Object.entries(build.configurations ?? {})) check(`configurations.${name}`, cfg);
  return findings;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return null;
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

function parseArgs(argv) {
  const out = { services: [], file: undefined, policy: undefined, writeAllowlist: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--service') out.services.push(argv[++i]);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--policy') out.policy = argv[++i];
    else if (a === '--write-allowlist') out.writeAllowlist = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.writeAllowlist) {
    const out = {};
    for (const s of ALLOWLISTED_SERVICES) {
      const file = resolve(ROOT, 'apps', s, 'dist', 'main.js');
      out[s] = bundledPackages(readFileSync(file, 'utf8'));
    }
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify({ check: 'artifacts', wrote: ALLOWLIST_PATH, counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])) }));
    return;
  }

  const allowlists = loadAllowlist();
  /** @type {{ service: string, file: string, checkBuildOptions: boolean }[]} */
  const targets = [];
  if (args.file) {
    if (!args.policy || !POLICY[args.policy]) throw new Error('--file requires --policy <worker|risk-authorizer|execution-service>');
    targets.push({ service: args.policy, file: resolve(args.file), checkBuildOptions: false });
  } else {
    const services = args.services.length ? args.services : Object.keys(POLICY);
    for (const s of services) {
      if (!POLICY[s]) throw new Error(`no artifact policy for service ${s}`);
      targets.push({ service: s, file: resolve(ROOT, 'apps', s, 'dist', 'main.js'), checkBuildOptions: true });
    }
  }

  let failed = false;
  for (const t of targets) {
    const base = { check: 'artifacts', service: t.service, file: t.file };
    if (!existsSync(t.file)) {
      console.error(JSON.stringify({ ...base, ok: false, reason: 'bundle missing; run nx build first' }));
      failed = true;
      continue;
    }
    const text = readFileSync(t.file, 'utf8');
    if (text.length < 1024) {
      console.error(JSON.stringify({ ...base, ok: false, reason: 'bundle implausibly small' }));
      failed = true;
      continue;
    }
    const needsAllowlist = ALLOWLISTED_SERVICES.includes(t.service);
    const allowlist = needsAllowlist ? allowlists?.[t.service] ?? null : null;
    const buildOptions = t.checkBuildOptions ? buildOptionsFindings(t.service) : [];
    const scan = scanBundle(text, POLICY[t.service], allowlist);
    if (needsAllowlist && !allowlist) scan.canary.push(`no allowlist for ${t.service} in tools/artifact-allowlist.json`);
    const ok =
      scan.canary.length === 0 && buildOptions.length === 0 && scan.banned.length === 0 && scan.notAllowlisted.length === 0 && scan.bareRequires.length === 0 && scan.dynamicRequires.length === 0;
    const report = { ...base, bytes: text.length, bannedPatterns: POLICY[t.service].length, packages: bundledPackages(text).length, allowlisted: needsAllowlist, ok };
    if (ok) console.log(JSON.stringify(report));
    else {
      console.error(
        JSON.stringify(
          {
            ...report,
            canary: scan.canary,
            buildOptions,
            banned: scan.banned.slice(0, 20),
            notAllowlisted: scan.notAllowlisted.slice(0, 40),
            bareRequires: scan.bareRequires.slice(0, 20),
            dynamicRequires: scan.dynamicRequires.slice(0, 20),
          },
          null,
          2,
        ),
      );
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
