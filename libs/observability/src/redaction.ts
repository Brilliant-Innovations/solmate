/**
 * Secret redaction by construction (blueprint §22.1, §23.2 "secret redaction tests").
 *
 * Every log line, error report and trace attribute passes through `redact` before leaving the
 * process. Redaction is decided by key name and by value shape, so a secret reaches the sink
 * neither under an obvious key nor smuggled inside a free-text field.
 */

export const REDACTED = '[REDACTED]';

/** Key names (case-insensitive, substring match) whose values are always redacted. */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'token',
  'apikey',
  'api_key',
  'private',
  'pkcs8',
  'seed',
  'mnemonic',
  'authorization',
  'cookie',
  'service_role',
  'serviceRole',
  'signature', // application signatures are fine to log by hash, never raw
  'credential',
  'dsn',
];

/** Value shapes that are redacted wherever they appear, including inside strings. */
// No leading \b on prefixed tokens: a secret glued to other text (e.g. "id=0sb_secret_...") must still match.
const VALUE_PATTERNS: readonly RegExp[] = [
  /(?:sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/g, // Supabase keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic keys (before the generic sk- pattern)
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style API keys
  /[0-9a-f]{96,}/g, // PKCS#8 / long hex key material (hashes are 64 chars and stay visible)
  /[1-9A-HJ-NP-Za-km-z]{87,88}(?![1-9A-HJ-NP-Za-km-z])/g, // base58 64-byte secret keys (signatures are the same length; never log raw)
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/g, // password in a database URL
  /(https?:\/\/)[^:@\s/]+:[^@\s/]+@/g, // basic-auth credentials in URLs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((f) => k.includes(f.toLowerCase()));
}

export function redactString(value: string): string {
  let out = value;
  for (const p of VALUE_PATTERNS) {
    out = out.replace(p, (match, ...groups: unknown[]) => {
      // patterns with capture groups keep the non-secret prefix/suffix
      if (typeof groups[0] === 'string' && typeof groups[1] === 'string') return `${groups[0]}${REDACTED}${groups[1]}`;
      if (typeof groups[0] === 'string' && groups.length > 2) return `${groups[0]}${REDACTED}@`;
      return REDACTED;
    });
  }
  return out;
}

const MAX_DEPTH = 12;

/** Deep-redacts a value. Never throws; unknown types are stringified then redacted. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? (v === null || v === undefined ? v : REDACTED) : redact(v, depth + 1);
    }
    return out;
  }
  return redactString(String(value));
}
