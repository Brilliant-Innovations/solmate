/**
 * Database access layer (blueprint §5.3). SQL migrations under /supabase/migrations are the schema
 * authority; `database.types.ts` is generated from them with `supabase gen types` and must never be
 * edited by hand. Repositories and the queue adapter are added from M2 onward.
 */
export type { Database, Enums, Json, Tables, TablesInsert, TablesUpdate } from './database.types.js';
export * from './queues.js';
