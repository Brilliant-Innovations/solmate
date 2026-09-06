import fc from 'fast-check';
import { createLogger, type LogRecord } from './logger.js';
import { isSensitiveKey, redact, REDACTED, redactString } from './redaction.js';

// Synthetic secrets assembled at runtime so no secret-shaped literal ever appears in source
// (GitHub push protection would otherwise, correctly, refuse the commit).
const b64 = (n: number) => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.slice(0, n);
const SECRETS = {
  supabaseSecret: ['sb', 'secret', 'TESTONLY' + 'x'.repeat(24)].join('_'),
  jwt: ['eyJ' + b64(20), 'eyJ' + b64(24), b64(30)].join('.'),
  openai: 'sk-' + 'testonly'.repeat(4),
  anthropic: 'sk-ant-' + 'testonly'.repeat(4),
  pkcs8: 'a'.repeat(120),
  base58Secret: '5'.repeat(88),
  dbUrl: 'postgresql://postgres:hunter2@db.example.com:5432/postgres',
  pem: ['-----BEGIN PRIVATE KEY-----', 'TESTONLY' + b64(30), '-----END PRIVATE KEY-----'].join('\n'),
};

describe('redaction (§22.1, §23.2)', () => {
  it('redacts every known secret shape inside free text', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const out = redactString(`context before ${secret} context after`);
      expect(out, name).not.toContain(secret);
      expect(out, name).toContain(REDACTED);
    }
    expect(redactString(SECRETS.dbUrl)).toBe('postgresql://postgres:[REDACTED]@db.example.com:5432/postgres');
  });

  it('leaves sha256 hashes, base58 addresses and normal text intact', () => {
    const hash = 'b'.repeat(64);
    const address = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const text = `hash ${hash} address ${address} amount 250000000 intent 66666666-6666-4666-8666-666666666666`;
    expect(redactString(text)).toBe(text);
  });

  it('redacts by key name at any depth and keeps structure', () => {
    const out = redact({ ok: 1, nested: { apiKey: 'x', Authorization: 'Bearer y', list: [{ password: 'p' }, 'plain'] }, SUPABASE_SERVICE_ROLE_KEY: 'k' }) as Record<string, unknown>;
    expect(out).toEqual({ ok: 1, nested: { apiKey: REDACTED, Authorization: REDACTED, list: [{ password: REDACTED }, 'plain'] }, SUPABASE_SERVICE_ROLE_KEY: REDACTED });
    expect(isSensitiveKey('TURNKEY_API_PRIVATE_KEY')).toBe(true);
    expect(isSensitiveKey('intentId')).toBe(false);
  });

  it('property: no known secret survives redaction wherever it is embedded', () => {
    const secretArb = fc.constantFrom(...Object.values(SECRETS));
    const keyArb = fc.stringMatching(/^[a-zA-Z_]{1,12}$/);
    fc.assert(
      fc.property(secretArb, keyArb, fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (secret, key, pre, post) => {
        const payload = { [key]: `${pre}${secret}${post}`, arr: [pre, { deep: `${secret}` }], err: new Error(`failed: ${secret}`) };
        const text = JSON.stringify(redact(payload));
        // the raw secret must be gone; for the DB URL only the password part is the secret
        const needle = secret === SECRETS.dbUrl ? 'hunter2' : secret;
        expect(text).not.toContain(needle);
      }),
      { numRuns: 300 },
    );
  });

  it('the logger redacts fields and carries service, event, time and correlation context', () => {
    const lines: LogRecord[] = [];
    const log = createLogger({ service: 'worker', sink: (r) => lines.push(r), now: () => '2026-09-06T00:00:00.000Z' }).child({ intentId: 'i-1', correlationId: 'c-1' });
    log.info('startup', { token: 'abc', dbUrl: SECRETS.dbUrl, ok: true });
    log.debug('hidden-by-level');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', service: 'worker', event: 'startup', at: '2026-09-06T00:00:00.000Z', intentId: 'i-1', correlationId: 'c-1', token: REDACTED, ok: true });
    expect(String(lines[0]?.['dbUrl'])).not.toContain('hunter2');
  });
});
