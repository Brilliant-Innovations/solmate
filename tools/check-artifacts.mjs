#!/usr/bin/env node
/**
 * Forbidden-package scan on built artifacts (GUARDRAILS.md Part 4; blueprint D50, §24.8).
 *
 * Source-level lint stops a banned import from being written. This check looks at what was
 * actually built, so a transitive dependency, a generated file or a mis-tagged project cannot
 * smuggle an LLM SDK, a signer SDK, a DEX SDK or browser code into a financial deployable.
 *
 * Two properties are checked per bundle:
 *   1. No banned package marker for the service's trust level appears anywhere in the bundle
 *      (esbuild module-path comments, pnpm store paths, or literal require/import specifiers).
 *   2. The bundle is self-contained: every literal `require("x")` names a Node built-in. A bare
 *      third-party require would mean the runtime image needs node_modules the image does not
 *      carry, and that the scan has a blind spot.
 *
 * Usage:
 *   node tools/check-artifacts.mjs                       # every service, apps/<service>/dist/main.js
 *   node tools/check-artifacts.mjs --service worker      # one service (repeatable)
 *   node tools/check-artifacts.mjs --file x.js --policy risk-authorizer   # arbitrary file (CI negative test)
 *
 * Exit code 1 on any finding. The lists below mirror eslint.config.mjs; change both or neither.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const LLM_SDKS = ['@anthropic-ai/*', 'openai', '@google/generative-ai', '@google/genai', '@ai-sdk/*', 'ai'];
const SIGNER_SDKS = ['@turnkey/*', '@privy-io/*'];
const DEX_SDKS = ['@jup-ag/*', '@raydium-io/*', '@orca-so/*', '@meteora-ag/*'];
const BROWSER_STACK = ['@solana/kit-plugin-wallet', '@solana/react', 'react', 'react-dom', 'next', '@base-ui/react'];
const WALLET_STANDARD = ['@wallet-standard/*', '@solana/wallet-standard*'];
// Provider clients the isolated processes must never carry (news/social/market SDKs).
const PROVIDER_CLIENTS = ['lunarcrush*', 'cryptopanic*', '@birdeye*', 'helius-sdk', '@helius-labs/*'];

/** @type {Record<string, string[]>} */
export const POLICY = {
  'risk-authorizer': [...LLM_SDKS, ...SIGNER_SDKS, ...DEX_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS],
  'execution-service': [...LLM_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS],
  worker: [...SIGNER_SDKS],
};

const PACKAGE_SPECIFIER = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/\S*)?$/;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Regexes that recognise one package pattern in bundle text. `*` matches one path segment. */
function markerRegexes(pattern) {
  const seg = '[^/"\'\\s@]+';
  const pkg = escapeRe(pattern).replaceAll('*', seg);
  // pnpm store folders encode `@scope/name@version` as `@scope+name@version`.
  const pnpmFolder = escapeRe(pattern).replace('/', '\\+').replaceAll('*', seg);
  return [
    new RegExp(`node_modules/${pkg}/`, 'g'),
    new RegExp(`\\.pnpm/${pnpmFolder}@`, 'g'),
    new RegExp(`require\\((["'])${pkg}(?:/[^"']*)?\\1\\)`, 'g'),
    new RegExp(`(?:from|import)\\s*\\(?\\s*(["'])${pkg}(?:/[^"']*)?\\1`, 'g'),
  ];
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * @returns {{ banned: {pattern: string, line: number, sample: string}[],
 *             bareRequires: {specifier: string, line: number}[] }}
 */
export function scanBundle(text, bannedPatterns) {
  const banned = [];
  for (const pattern of bannedPatterns) {
    for (const re of markerRegexes(pattern)) {
      let m;
      while ((m = re.exec(text)) !== null) {
        banned.push({ pattern, line: lineOf(text, m.index), sample: m[0].slice(0, 160) });
        if (banned.length > 50) return { banned, bareRequires: [] };
      }
    }
  }
  const bareRequires = [];
  const reqRe = /\brequire\((["'])([^"'\n]+)\1\)/g;
  let m;
  while ((m = reqRe.exec(text)) !== null) {
    const spec = m[2];
    if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue;
    // Only syntactically valid package specifiers count; log format strings such as "%s" do not.
    if (!PACKAGE_SPECIFIER.test(spec)) continue;
    bareRequires.push({ specifier: spec, line: lineOf(text, m.index) });
  }
  return { banned, bareRequires };
}

function parseArgs(argv) {
  const out = { services: [], file: undefined, policy: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--service') out.services.push(argv[++i]);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--policy') out.policy = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  /** @type {{ service: string, file: string }[]} */
  const targets = [];
  if (args.file) {
    if (!args.policy || !POLICY[args.policy]) throw new Error('--file requires --policy <worker|risk-authorizer|execution-service>');
    targets.push({ service: args.policy, file: resolve(args.file) });
  } else {
    const services = args.services.length ? args.services : Object.keys(POLICY);
    for (const s of services) {
      if (!POLICY[s]) throw new Error(`no artifact policy for service ${s}`);
      targets.push({ service: s, file: resolve(root, 'apps', s, 'dist', 'main.js') });
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
    const { banned, bareRequires } = scanBundle(text, POLICY[t.service]);
    const ok = banned.length === 0 && bareRequires.length === 0;
    const report = { ...base, bytes: text.length, bannedPatterns: POLICY[t.service].length, ok };
    if (ok) console.log(JSON.stringify(report));
    else {
      console.error(JSON.stringify({ ...report, banned: banned.slice(0, 20), bareRequires: bareRequires.slice(0, 20) }, null, 2));
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
