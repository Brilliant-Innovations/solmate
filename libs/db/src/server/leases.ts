import type { Sql } from './sql.js';

/**
 * Worker leases (blueprint P0 acceptance "workers recover leases"; §21.3 restart recovery).
 * One holder per role. The holder heartbeats; when a heartbeat fails the holder must stop acting
 * for that role immediately (the lease may already belong to someone else).
 */
export class LeaseManager {
  constructor(private readonly sql: Sql, readonly holder: string) {}

  async acquire(role: string, ttlSeconds: number): Promise<boolean> {
    const [row] = await this.sql<{ acquire_lease: boolean }[]>`select ops.acquire_lease(${role}, ${this.holder}, ${ttlSeconds}) as acquire_lease`;
    return row?.acquire_lease ?? false;
  }

  async heartbeat(role: string, ttlSeconds: number): Promise<boolean> {
    const [row] = await this.sql<{ heartbeat_lease: boolean }[]>`select ops.heartbeat_lease(${role}, ${this.holder}, ${ttlSeconds}) as heartbeat_lease`;
    return row?.heartbeat_lease ?? false;
  }

  async release(role: string): Promise<boolean> {
    const [row] = await this.sql<{ release_lease: boolean }[]>`select ops.release_lease(${role}, ${this.holder}) as release_lease`;
    return row?.release_lease ?? false;
  }
}

export interface LeasedRunOptions {
  role: string;
  ttlSeconds: number;
  heartbeatIntervalMs: number;
}

/**
 * Runs `work` while holding the lease, heartbeating on an interval. `work` receives an
 * `isFenced()` predicate that flips true the moment a heartbeat fails; loops must check it before
 * every side effect. Returns false without running if the lease could not be acquired.
 */
export async function runWithLease(
  leases: LeaseManager,
  options: LeasedRunOptions,
  work: (isFenced: () => boolean) => Promise<void>,
): Promise<boolean> {
  if (!(await leases.acquire(options.role, options.ttlSeconds))) return false;
  let fenced = false;
  const timer = setInterval(() => {
    void leases.heartbeat(options.role, options.ttlSeconds).then((ok) => {
      if (!ok) fenced = true;
    }, () => {
      fenced = true;
    });
  }, options.heartbeatIntervalMs);
  try {
    await work(() => fenced);
  } finally {
    clearInterval(timer);
    if (!fenced) await leases.release(options.role);
  }
  return true;
}
