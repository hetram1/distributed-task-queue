import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { LOCK_CONFIG } from './constants';

export interface LockOptions {
  /** How long the lock is held before auto-release (ms). Default: 30000 (30s). */
  ttlMs?: number;
  /** How long to wait trying to acquire the lock (ms). Default: 10000 (10s). */
  acquireTimeoutMs?: number;
  /** How often to retry acquiring a busy lock (ms). Default: 200. */
  retryIntervalMs?: number;
  /** Unique identifier for the lock owner. Default: auto-generated UUID. */
  ownerId?: string;
  /** Extra fields merged into the lock's stored metadata (e.g. workerId, jobId) for GET /api/v1/locks visibility. */
  metadata?: Record<string, unknown>;
}

export interface LockResult {
  acquired: boolean;
  lockKey: string;
  ownerId: string;
  ttlMs: number;
  acquiredAt?: string;
  /** Release function — call this when done with the resource. No-op (returns false) if the lock was never acquired. */
  release: () => Promise<boolean>;
}

export interface LockInfo {
  lockKey: string;
  ownerId: string;
  acquiredAt: string;
  ttlMs: number;
  remainingMs: number;
  resourceType: string;
  resourceId: string;
  [extra: string]: unknown;
}

// Only the owner can release/extend its own lock — GET+compare+DEL as
// separate commands would let another process acquire the lock in between
// and have it deleted out from under them. These run atomically in Redis.
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("srem", KEYS[2], KEYS[1])
    redis.call("del", KEYS[3])
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const EXTEND_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("pexpire", KEYS[2], ARGV[2])
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

function lockKeyFor(resourceType: string, resourceId: string): string {
  return `${LOCK_CONFIG.KEY_PREFIX}${resourceType}:${resourceId}`;
}
function metaKeyFor(resourceType: string, resourceId: string): string {
  return `${LOCK_CONFIG.META_PREFIX}${resourceType}:${resourceId}`;
}
function metaKeyFromLockKey(lockKey: string): string {
  return LOCK_CONFIG.META_PREFIX + lockKey.slice(LOCK_CONFIG.KEY_PREFIX.length);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Distributed lock manager using Redis `SET NX PX` for acquisition and Lua
 * scripts for release/extend, so a process can only ever release or extend
 * a lock it currently owns.
 *
 * Has no BullMQ dependency (pure Redis primitives), so it lives in the
 * shared package: the worker instantiates one to guard resources while
 * processing, and the API server instantiates its own (against the same
 * Redis keys) for the read-only/admin `/api/v1/locks` endpoints.
 */
export class DistributedLockManager {
  constructor(private readonly redis: Redis) {}

  /** Acquires a lock on a resource, retrying until acquired or `acquireTimeoutMs` elapses. */
  async acquireLock(resourceType: string, resourceId: string, options: LockOptions = {}): Promise<LockResult> {
    const ttlMs = options.ttlMs ?? LOCK_CONFIG.DEFAULT_TTL_MS;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? LOCK_CONFIG.DEFAULT_ACQUIRE_TIMEOUT_MS;
    const retryIntervalMs = options.retryIntervalMs ?? LOCK_CONFIG.DEFAULT_RETRY_INTERVAL_MS;
    const ownerId = options.ownerId ?? randomUUID();

    const lockKey = lockKeyFor(resourceType, resourceId);
    const metaKey = metaKeyFor(resourceType, resourceId);
    const deadline = Date.now() + acquireTimeoutMs;
    let wasContended = false;

    for (;;) {
      const result = await this.redis.set(lockKey, ownerId, 'PX', ttlMs, 'NX');

      if (result === 'OK') {
        const acquiredAt = new Date().toISOString();
        const metadata = { ownerId, acquiredAt, resourceType, resourceId, ttlMs, ...options.metadata };

        await this.redis.set(metaKey, JSON.stringify(metadata), 'PX', ttlMs);
        await this.redis.sadd(LOCK_CONFIG.REGISTRY_KEY, lockKey);
        await this.redis.hincrby(LOCK_CONFIG.STATS_KEY, 'totalAcquired', 1);
        if (wasContended) {
          await this.redis.hincrby(LOCK_CONFIG.STATS_KEY, 'totalContended', 1);
        }

        return {
          acquired: true,
          lockKey,
          ownerId,
          ttlMs,
          acquiredAt,
          release: () => this.releaseLock(lockKey, ownerId),
        };
      }

      wasContended = true;
      if (Date.now() + retryIntervalMs > deadline) {
        await this.redis.hincrby(LOCK_CONFIG.STATS_KEY, 'totalTimeouts', 1);
        return { acquired: false, lockKey, ownerId, ttlMs, release: async () => false };
      }
      await sleep(retryIntervalMs);
    }
  }

  /** Releases a lock — only succeeds if `ownerId` matches the current holder. Returns whether it actually released something. */
  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    const metaKey = metaKeyFromLockKey(lockKey);

    try {
      const raw = await this.redis.get(metaKey);
      if (raw) {
        const meta = JSON.parse(raw) as { acquiredAt?: string };
        if (meta.acquiredAt) {
          const heldMs = Math.max(0, Date.now() - new Date(meta.acquiredAt).getTime());
          await this.redis.hincrby(LOCK_CONFIG.STATS_KEY, 'totalHoldTimeMs', Math.round(heldMs));
          await this.redis.hincrby(LOCK_CONFIG.STATS_KEY, 'releaseCount', 1);
        }
      }
    } catch {
      // Hold-time stats are best-effort — never let them block the actual release.
    }

    const result = await this.redis.eval(RELEASE_SCRIPT, 3, lockKey, LOCK_CONFIG.REGISTRY_KEY, metaKey, ownerId);
    return Number(result) === 1;
  }

  /** Extends a lock's TTL — only succeeds if `ownerId` matches the current holder. */
  async extendLock(lockKey: string, ownerId: string, additionalMs: number): Promise<boolean> {
    const metaKey = metaKeyFromLockKey(lockKey);
    const result = await this.redis.eval(EXTEND_SCRIPT, 2, lockKey, metaKey, ownerId, additionalMs);
    return Number(result) === 1;
  }

  /** Whether a resource is currently locked. */
  async isLocked(resourceType: string, resourceId: string): Promise<boolean> {
    const exists = await this.redis.exists(lockKeyFor(resourceType, resourceId));
    return exists === 1;
  }

  /** Info about a specific lock, or null if it's not currently held. */
  async getLockInfo(resourceType: string, resourceId: string): Promise<LockInfo | null> {
    const lockKey = lockKeyFor(resourceType, resourceId);
    const metaKey = metaKeyFor(resourceType, resourceId);
    const [ownerId, metaRaw, ttl] = await Promise.all([
      this.redis.get(lockKey),
      this.redis.get(metaKey),
      this.redis.pttl(lockKey),
    ]);
    if (!ownerId) return null;

    const meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {};
    return {
      resourceType,
      resourceId,
      ...meta,
      lockKey,
      ownerId,
      acquiredAt: (meta.acquiredAt as string) ?? new Date().toISOString(),
      ttlMs: (meta.ttlMs as number) ?? 0,
      remainingMs: ttl > 0 ? ttl : 0,
    };
  }

  /** Lists all currently active locks from the registry, pruning any stale entries (expired without going through releaseLock). */
  async getActiveLocks(): Promise<LockInfo[]> {
    const lockKeys = await this.redis.smembers(LOCK_CONFIG.REGISTRY_KEY);
    const infos: LockInfo[] = [];

    for (const lockKey of lockKeys) {
      const metaKey = metaKeyFromLockKey(lockKey);
      const [ownerId, metaRaw, ttl] = await Promise.all([
        this.redis.get(lockKey),
        this.redis.get(metaKey),
        this.redis.pttl(lockKey),
      ]);

      if (!ownerId) {
        await this.redis.srem(LOCK_CONFIG.REGISTRY_KEY, lockKey);
        continue;
      }

      const meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {};
      infos.push({
        resourceType: (meta.resourceType as string) ?? '',
        resourceId: (meta.resourceId as string) ?? '',
        ...meta,
        lockKey,
        ownerId,
        acquiredAt: (meta.acquiredAt as string) ?? new Date().toISOString(),
        ttlMs: (meta.ttlMs as number) ?? 0,
        remainingMs: ttl > 0 ? ttl : 0,
      });
    }

    return infos;
  }

  /** Aggregate lock statistics for the health endpoint / monitoring. */
  async getStats(): Promise<{
    activeLocks: number;
    totalAcquired: number;
    totalContended: number;
    totalTimeouts: number;
    avgHoldTimeMs: number;
  }> {
    const [activeLocks, statsHash] = await Promise.all([
      this.redis.scard(LOCK_CONFIG.REGISTRY_KEY),
      this.redis.hgetall(LOCK_CONFIG.STATS_KEY),
    ]);

    const totalHoldTimeMs = Number(statsHash.totalHoldTimeMs ?? 0);
    const releaseCount = Number(statsHash.releaseCount ?? 0);

    return {
      activeLocks,
      totalAcquired: Number(statsHash.totalAcquired ?? 0),
      totalContended: Number(statsHash.totalContended ?? 0),
      totalTimeouts: Number(statsHash.totalTimeouts ?? 0),
      avgHoldTimeMs: releaseCount > 0 ? Math.round(totalHoldTimeMs / releaseCount) : 0,
    };
  }

  /** Force-releases a lock regardless of owner — admin operation for stuck locks. Returns whether a lock actually existed. */
  async forceRelease(resourceType: string, resourceId: string): Promise<boolean> {
    const lockKey = lockKeyFor(resourceType, resourceId);
    const metaKey = metaKeyFor(resourceType, resourceId);

    const [deleted] = await Promise.all([
      this.redis.del(lockKey),
      this.redis.del(metaKey),
      this.redis.srem(LOCK_CONFIG.REGISTRY_KEY, lockKey),
    ]);
    return deleted === 1;
  }
}
