import type { Redis } from 'ioredis';
import { CONCURRENCY_CONFIG } from './constants';

function keyFor(jobType: string): string {
  return `${CONCURRENCY_CONFIG.KEY_PREFIX}${jobType}`;
}

/**
 * Per-job-type concurrency limiter using Redis atomic counters, shared
 * across all worker processes. No BullMQ dependency, so — like
 * {@link DistributedLockManager} — it lives in shared and is instantiated
 * independently by the worker (acquire/release around processing) and the
 * API server (read-only usage + admin reset endpoints).
 *
 * Acquisition is INCR-then-check-then-DECR-to-rollback, not a single atomic
 * primitive — under extreme contention this can allow a slot briefly over
 * the limit before rolling back. Acceptable for a soft concurrency limiter;
 * not a hard guarantee.
 */
export class ConcurrencyLimiter {
  constructor(private readonly redis: Redis) {}

  /** Attempts to claim a concurrency slot for a job type. Returns false if the type's limit is already reached. */
  async acquireSlot(jobType: string): Promise<boolean> {
    const limit = CONCURRENCY_CONFIG.LIMITS[jobType];
    if (limit === undefined) return true; // no limit configured for this type

    const current = await this.redis.incr(keyFor(jobType));
    if (current <= limit) {
      return true;
    }
    await this.releaseSlot(jobType);
    return false;
  }

  /** Releases a previously-acquired slot. Clamps at 0 so a crash or double-release can't drive the counter negative. */
  async releaseSlot(jobType: string): Promise<void> {
    const newValue = await this.redis.decr(keyFor(jobType));
    if (newValue < 0) {
      await this.redis.set(keyFor(jobType), '0');
    }
  }

  /** Current active count vs. configured limit for every known job type. */
  async getCurrentUsage(): Promise<Record<string, { active: number; limit: number }>> {
    const types = Object.keys(CONCURRENCY_CONFIG.LIMITS);
    const values = await Promise.all(types.map((type) => this.redis.get(keyFor(type))));

    const usage: Record<string, { active: number; limit: number }> = {};
    types.forEach((type, i) => {
      usage[type] = { active: Math.max(0, Number(values[i] ?? 0)), limit: CONCURRENCY_CONFIG.LIMITS[type] };
    });
    return usage;
  }

  /** Resets all counters to 0 — admin operation for when counters drift out of sync (e.g. after a worker crash). */
  async resetCounters(): Promise<void> {
    const types = Object.keys(CONCURRENCY_CONFIG.LIMITS);
    if (types.length === 0) return;
    await this.redis.del(...types.map((type) => keyFor(type)));
  }
}
