#!/usr/bin/env node
/**
 * Renders the Terraform cloud-init template and checks the files it generates (plan M11; adversarial
 * review 2026-09-09 findings C-1, H-9, H-10).
 *
 * `terraform validate` does not look inside a `templatefile()` string, and there is no Terraform
 * binary in this workspace, so nothing here had ever parsed the shell and systemd units that
 * `deploy/terraform/modules/solmate-host/cloud-init.yaml.tftpl` produces. Two defects that would
 * have bricked a Profile 3/4 promotion lived in the first ten lines of that output:
 *   - a service with no listeners rendered an empty `{ }` shell group (a syntax error, and the
 *     script is `set -eu` inside a `Type=oneshot` unit every service `Requires=`);
 *   - service units named their mount unit by hand, but systemd escapes a literal `-` inside a path
 *     component to `\x2d`, so `risk-authorizer` and `execution-service` named units that cannot exist.
 *
 * This renders the template for service shapes that cover both cases and checks the result with the
 * system shell. It is a lint, not a substitute for `terraform validate` at promotion.
 *
 * Usage: node tools/check-cloud-init.mjs
 * Exit code 1 on any finding.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TEMPLATE = resolve(ROOT, 'deploy/terraform/modules/solmate-host/cloud-init.yaml.tftpl');

/**
 * Service shapes the two roots actually declare, plus the properties that matter here: a
 * listener-less service (the worker), interior dashes in every isolated service name, and a service
 * carrying both a private and a public listener (the executor).
 */
const CASES = [
  {
    profile: 'P3',
    services: [
      { name: 'worker', listen: {}, public_listen: {}, journal_env: 'AUDIT_CHECKPOINT_PATH', extra_env: { SHADOW_JOURNAL_PATH: '/journal/shadow.jsonl' } },
      { name: 'risk-authorizer', listen: { INTERNAL_API_LISTEN: 8781 }, public_listen: {}, journal_env: 'AUDIT_CHECKPOINT_PATH', extra_env: {} },
      { name: 'execution-service', listen: { INTERNAL_API_LISTEN: 8791 }, public_listen: { OUT_OF_BAND_LISTEN: 8792 }, journal_env: 'EXECUTOR_JOURNAL_PATH', extra_env: {} },
    ],
  },
  { profile: 'P4', services: [{ name: 'worker', listen: {}, public_listen: {}, journal_env: 'AUDIT_CHECKPOINT_PATH', extra_env: { SHADOW_JOURNAL_PATH: '/journal/shadow.jsonl' } }] },
  { profile: 'P4', services: [{ name: 'execution-service', listen: { INTERNAL_API_LISTEN: 8791 }, public_listen: { OUT_OF_BAND_LISTEN: 8792 }, journal_env: 'EXECUTOR_JOURNAL_PATH', extra_env: {} }] },
];

/**
 * Minimal renderer for the HCL template subset this file uses: `%{ for a in b ~}` / `%{ for k, v in m ~}`
 * / `%{ endfor ~}` line directives and `${expr}` interpolation over a flat scope. It deliberately
 * refuses anything it does not understand rather than rendering it wrong.
 */
function render(template, scope) {
  const lines = template.split(/\r?\n/);
  const out = [];
  const evaluate = (expr, vars) => {
    const path = expr.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(path)) {
      if (!(path in vars)) throw new Error(`template references unknown variable ${path}`);
      return vars[path];
    }
    const dotted = path.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (dotted && dotted[1] in vars) return vars[dotted[1]][dotted[2]];
    const indexed = path.match(/^([A-Za-z_][A-Za-z0-9_]*)\[([A-Za-z_][A-Za-z0-9_.]*)\]$/);
    if (indexed && indexed[1] in vars) return vars[indexed[1]][evaluate(indexed[2], vars)];
    throw new Error(`template expression not supported by this checker: ${path}`);
  };
  const interpolate = (line, vars) => line.replace(/\$\{([^}]+)\}/g, (_m, e) => String(evaluate(e, vars)));

  const walk = (from, to, vars) => {
    let i = from;
    while (i < to) {
      const line = lines[i];
      const forEach = line.match(/^\s*%\{\s*for\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([A-Za-z_][A-Za-z0-9_]*))?\s+in\s+([A-Za-z_][A-Za-z0-9_.[\]]*)\s*~\}\s*$/);
      if (forEach) {
        const [, a, b, collectionExpr] = forEach;
        let depth = 1;
        let j = i + 1;
        for (; j < to; j++) {
          if (/^\s*%\{\s*for\s/.test(lines[j])) depth++;
          else if (/^\s*%\{\s*endfor\s*~?\}\s*$/.test(lines[j])) {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) throw new Error(`unterminated for at line ${i + 1}`);
        const collection = evaluate(collectionExpr, vars);
        const entries = b === undefined ? (collection ?? []).map((v) => [v, undefined]) : Object.entries(collection ?? {});
        for (const [first, second] of entries) walk(i + 1, j, b === undefined ? { ...vars, [a]: first } : { ...vars, [a]: first, [b]: second });
        i = j + 1;
        continue;
      }
      if (/^\s*%\{/.test(line)) throw new Error(`unsupported template directive at line ${i + 1}: ${line.trim()}`);
      out.push(interpolate(line, vars));
      i++;
    }
  };
  walk(0, lines.length, scope);
  return out.join('\n');
}

/** Pulls one `- path: X` write_files entry's `content: |` block back out of the rendered cloud-config. */
function fileFromCloudConfig(rendered, path) {
  const lines = rendered.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- path: ${path}`);
  if (start < 0) return null;
  const contentAt = lines.findIndex((l, i) => i > start && l.trim() === 'content: |');
  if (contentAt < 0) return null;
  const indent = (lines[contentAt].match(/^\s*/) ?? [''])[0].length + 2;
  const body = [];
  for (let i = contentAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if ((l.match(/^\s*/) ?? [''])[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const template = readFileSync(TEMPLATE, 'utf8');
const findings = [];
const dir = mkdtempSync(join(tmpdir(), 'solmate-cloudinit-'));
try {
  for (const c of CASES) {
    const label = `${c.profile}:${c.services.map((s) => s.name).join('+')}`;
    const rendered = render(template, {
      hostname: `host-${c.profile.toLowerCase()}`,
      profile: c.profile,
      image_tag: 'sha-0000000000000000000000000000000000000000',
      registry: 'ghcr.io/brilliant-innovations',
      services: c.services,
      volumes: Object.fromEntries(c.services.map((s) => [s.name, `host-${s.name}-journal`])),
      operator: 'solmate',
    });

    if (/\$\{|%\{/.test(rendered)) findings.push(`${label}: rendered output still contains an unrendered template directive`);

    // 1. The listener script must be valid shell for every service shape, including a service with
    //    no listeners at all (finding C-1).
    const script = fileFromCloudConfig(rendered, '/usr/local/sbin/solmate-listen');
    if (!script) findings.push(`${label}: solmate-listen was not rendered`);
    else {
      const file = join(dir, 'solmate-listen.sh');
      writeFileSync(file, script);
      for (const shell of ['sh', 'bash']) {
        try {
          execFileSync(shell, ['-n', file], { stdio: 'pipe' });
        } catch (err) {
          findings.push(`${label}: ${shell} -n rejected solmate-listen: ${String(err.stderr ?? err).trim().split('\n').slice(0, 2).join(' / ')}`);
        }
      }
      for (const s of c.services) {
        if (!script.includes(`: > /etc/solmate/${s.name}.listen.env`)) findings.push(`${label}: ${s.name}.listen.env is not truncated before being appended to`);
        for (const key of Object.keys(s.public_listen ?? {})) {
          if (!new RegExp(`echo "${key}=0\\.0\\.0\\.0:`).test(script)) findings.push(`${label}: ${key} must bind all interfaces (operator machines reach it from outside the VPC)`);
        }
        for (const key of Object.keys(s.listen ?? {})) {
          if (!new RegExp(`echo "${key}=\\$ip:`).test(script)) findings.push(`${label}: ${key} must bind the private VPC address`);
        }
      }
    }

    // 2. Service units must name the mount by path, not by a hand-built unit name (finding H-9).
    for (const s of c.services) {
      const unit = fileFromCloudConfig(rendered, `/etc/systemd/system/solmate-${s.name}.service`);
      if (!unit) {
        findings.push(`${label}: unit for ${s.name} was not rendered`);
        continue;
      }
      if (!unit.includes(`RequiresMountsFor=/var/lib/solmate/${s.name}`)) findings.push(`${label}: ${s.name} unit does not declare RequiresMountsFor for its journal volume`);
      const handBuilt = unit.match(/(?:After|Requires)=[^\n]*?(var-lib-solmate-\S+\.mount)/);
      if (handBuilt) findings.push(`${label}: ${s.name} unit names a mount unit by hand (${handBuilt[1]}); systemd escapes '-' to \\x2d, so this unit cannot exist`);
      if (!unit.includes(`ConditionPathExists=/etc/solmate/${s.name}.env`)) findings.push(`${label}: ${s.name} unit does not refuse to start without its operator-placed env file`);
      for (const flag of ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true']) {
        if (!unit.includes(flag)) findings.push(`${label}: ${s.name} unit dropped the container restriction ${flag}`);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ check: 'cloud-init', template: 'deploy/terraform/modules/solmate-host/cloud-init.yaml.tftpl', cases: CASES.length, findings: findings.length, ok: findings.length === 0 }));
for (const f of findings) console.error(JSON.stringify({ check: 'cloud-init', finding: f }));
process.exit(findings.length ? 1 : 0);
