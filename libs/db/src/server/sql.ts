import postgres, { type Sql } from 'postgres';

/**
 * Backend Postgres connection (blueprint §5.3, §5.4). Only worker, risk-authorizer and
 * execution-service use this; web never does (see eslint no-restricted-imports).
 *
 * The URL is a service credential and is read from the process environment of the service that
 * owns it. `prepare: false` keeps the client compatible with Supabase's transaction-mode pooler.
 */
export type { Sql };
export type JsonValue = postgres.JSONValue;

/** Wrap an already-validated plain object for a jsonb parameter without double encoding. */
export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

export interface SqlOptions {
  url: string;
  applicationName: string;
  max?: number;
}

export function createSql(options: SqlOptions): Sql {
  return postgres(options.url, {
    prepare: false,
    max: options.max ?? 4,
    connection: { application_name: options.applicationName },
    onnotice: () => undefined,
  });
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['SUPABASE_DB_URL'] ?? env['DATABASE_URL'];
}
