import nx from '@nx/eslint-plugin';

/**
 * Source-level trust boundaries (GUARDRAILS.md Part 4; blueprint D58, §4.1, §24.8).
 *
 * Every project carries one `type:`, one `trust:` and one `scope:` tag (see each
 * project's package.json `nx.tags`). The constraints below are the machine-readable
 * form of the dependency table and package-ban list in GUARDRAILS.md. Loosening a
 * constraint for a financial deployable is a reviewed change, not a convenience.
 */

// One list for lint and for the built-artifact scan (tools/check-artifacts.mjs).
import { BROWSER_STACK, DEX_SDKS, LLM_SDKS, PROVIDER_CLIENTS, SIGNER_SDKS, WALLET_STANDARD } from './tools/forbidden-packages.mjs';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*', '**/database.types.ts', '**/.vercel/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Apps never import apps.
            { sourceTag: 'type:app', notDependOnLibsWithTags: ['type:app'] },

            // ---- Financial deployables: strict allowlists ------------------------
            {
              sourceTag: 'trust:risk-authorizer',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:risk',
                'scope:solana-hard-state',
                'scope:db',
                'scope:observability',
                'scope:replay',
              ],
              bannedExternalImports: [
                ...LLM_SDKS,
                ...SIGNER_SDKS,
                ...DEX_SDKS,
                ...BROWSER_STACK,
                ...WALLET_STANDARD,
                ...PROVIDER_CLIENTS,
              ],
            },
            {
              sourceTag: 'trust:execution-service',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:execution',
                'scope:solana-hard-state',
                'scope:db',
                'scope:observability',
                'scope:replay',
              ],
              bannedExternalImports: [...LLM_SDKS, ...BROWSER_STACK, ...WALLET_STANDARD, ...PROVIDER_CLIENTS],
            },

            // ---- General worker: everything except browser wallet code ----------
            {
              sourceTag: 'trust:worker',
              notDependOnLibsWithTags: ['scope:wallet-ui', 'trust:web-only'],
              bannedExternalImports: [...SIGNER_SDKS],
            },

            // ---- Web: presentation and control plane only -----------------------
            // (server-only db entry point is additionally blocked below via no-restricted-imports)
            {
              sourceTag: 'trust:web',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:wallet-ui',
                'scope:db',
                'scope:observability',
              ],
              bannedExternalImports: [...SIGNER_SDKS, ...DEX_SDKS, ...LLM_SDKS],
            },

            // ---- Libraries -------------------------------------------------------
            // Shared libs may only lean on other shared libs.
            { sourceTag: 'trust:shared', onlyDependOnLibsWithTags: ['trust:shared'] },
            // contracts depends on nothing internal.
            { sourceTag: 'scope:contracts', onlyDependOnLibsWithTags: [] },
            // read-only chain inspection: no signer, no DEX, no browser.
            {
              sourceTag: 'scope:solana-hard-state',
              onlyDependOnLibsWithTags: ['scope:contracts', 'scope:observability'],
              bannedExternalImports: [...SIGNER_SDKS, ...DEX_SDKS, ...BROWSER_STACK, ...LLM_SDKS],
            },
            // risk policy is deterministic: no LLM, no signer, no DEX, no browser.
            {
              sourceTag: 'trust:risk',
              onlyDependOnLibsWithTags: ['trust:shared', 'trust:risk'],
              bannedExternalImports: [...LLM_SDKS, ...SIGNER_SDKS, ...DEX_SDKS, ...BROWSER_STACK],
            },
            // execution abstractions: no LLM, no browser.
            {
              sourceTag: 'trust:execution',
              onlyDependOnLibsWithTags: ['trust:shared', 'trust:execution'],
              bannedExternalImports: [...LLM_SDKS, ...BROWSER_STACK],
            },
            // browser wallet connector: contracts only; importable by web only.
            {
              sourceTag: 'trust:web-only',
              onlyDependOnLibsWithTags: ['scope:contracts'],
              bannedExternalImports: [...SIGNER_SDKS, ...DEX_SDKS, ...LLM_SDKS],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {},
  },
  // The browser control plane never holds a database connection or service credentials (§23.3).
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx', 'libs/wallet-ui/**/*.ts', 'libs/wallet-ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@sol-agent-trader/db/server', message: 'Server-only database access is not available to web (GUARDRAILS Part 4).' },
            { name: 'postgres', message: 'Web never opens a Postgres connection; use the anon Supabase client under RLS.' },
          ],
        },
      ],
    },
  },
];

/**
 * §18.2 clock discipline. Strategy, signal, agent, skill, risk, intelligence, market, on-chain,
 * replay and execution code reads time from a Clock, never from the wall clock, so replay can
 * supply simulated time without look-ahead. Each clock-bound project spreads this fragment into
 * its own eslint.config.mjs (flat-config `files` globs resolve relative to that file).
 */
export const clockDisciplineConfig = [
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.test.ts', '**/*.spec.tsx', '**/*.test.tsx'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Read time from a Clock (libs/contracts clock.ts), not Date.now() (blueprint §18.2).' },
        { object: 'performance', property: 'now', message: 'Use a Clock for decision time; performance.now() is for latency metrics only via observability.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() reads the wall clock. Use clock.now() (blueprint §18.2).',
        },
      ],
    },
  },
];
