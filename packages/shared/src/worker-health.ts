import type { Redis } from 'ioredis';

/**
 * Worker Health Reporter
 *
 * Each worker periodically reports its health to Redis; the API server's
 * analytics service reads these reports to show per-worker status without
 * needing a direct connection to any worker process.
 *
 * Redis keys:
 *   metrics:workers:active          — SET of active worker IDs
 *   metrics:workers:info:{id}       — HASH with worker details
 *   metrics:workers:heartbeat:{id}  — STRING with TTL (auto-expires if the worker crashes)
 *
 * A worker that crashes (vs. shutting down gracefully) never calls `stop()`,
 * so it stays in the active set but its heartbeat key expires — the reader
 * (`getActiveWorkers`) surfaces that as `isHealthy: false` rather than
 * silently disappearing, so a crashed worker is visible, not just absent.
 */

const ACTIVE_SET_KEY = 'metrics:workers:active';
const INFO_KEY_PREFIX = 'metrics:workers:info:';
const HEARTBEAT_KEY_PREFIX = 'metrics:workers:heartbeat:';
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TTL_SECONDS = 30;
/** How long a worker's info hash survives after its last heartbeat write — long enough to inspect a recently-crashed worker, short enough not to accumulate forever across dev restarts. */
const INFO_TTL_SECONDS = 86_400;

interface LocalStats {
  jobsProcessed: number;
  jobsCompleted: number;
  jobsFailed: number;
  startedAt: string;
  lastJobAt: string | null;
}

export interface WorkerHealthInfo {
  workerId: string;
  jobsProcessed: number;
  jobsCompleted: number;
  jobsFailed: number;
  successRate: number;
  startedAt: string;
  lastHeartbeat: string;
  lastJobAt: string | null;
  isHealthy: boolean;
}

export class WorkerHealthReporter {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private localStats: LocalStats;

  constructor(
    private readonly redis: Redis,
    private readonly workerId: string,
  ) {
    this.localStats = { jobsProcessed: 0, jobsCompleted: 0, jobsFailed: 0, startedAt: '', lastJobAt: null };
  }

  async start(): Promise<void> {
    try {
      this.localStats.startedAt = new Date().toISOString();
      await this.redis.sadd(ACTIVE_SET_KEY, this.workerId);
      await this.writeInfo();
      await this.refreshHeartbeat();
      this.heartbeatInterval = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    } catch (err) {
      console.warn(`[WorkerHealthReporter] Failed to start for ${this.workerId}:`, (err as Error).message);
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.refreshHeartbeat();
      await this.writeInfo();
    } catch (err) {
      console.warn(`[WorkerHealthReporter] Heartbeat failed for ${this.workerId}:`, (err as Error).message);
    }
  }

  /** Records a job outcome against this worker's local counters, and writes through immediately so the dashboard doesn't lag a full heartbeat interval behind. */
  async recordJobProcessed(succeeded: boolean): Promise<void> {
    this.localStats.jobsProcessed += 1;
    if (succeeded) this.localStats.jobsCompleted += 1;
    else this.localStats.jobsFailed += 1;
    this.localStats.lastJobAt = new Date().toISOString();
    await this.writeInfo();
  }

  async stop(): Promise<void> {
    try {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      await this.redis.srem(ACTIVE_SET_KEY, this.workerId);
      await this.redis.del(`${HEARTBEAT_KEY_PREFIX}${this.workerId}`);
    } catch (err) {
      console.warn(`[WorkerHealthReporter] Failed to stop cleanly for ${this.workerId}:`, (err as Error).message);
    }
  }

  private async refreshHeartbeat(): Promise<void> {
    await this.redis.set(`${HEARTBEAT_KEY_PREFIX}${this.workerId}`, '1', 'EX', HEARTBEAT_TTL_SECONDS);
  }

  private async writeInfo(): Promise<void> {
    const key = `${INFO_KEY_PREFIX}${this.workerId}`;
    await this.redis.hset(key, {
      jobsProcessed: this.localStats.jobsProcessed,
      jobsCompleted: this.localStats.jobsCompleted,
      jobsFailed: this.localStats.jobsFailed,
      startedAt: this.localStats.startedAt,
      lastHeartbeat: new Date().toISOString(),
      lastJobAt: this.localStats.lastJobAt ?? '',
    });
    await this.redis.expire(key, INFO_TTL_SECONDS);
  }

  /** Reads every worker that has ever registered (and not gracefully stopped) — called by the API server's analytics service. */
  static async getActiveWorkers(redis: Redis): Promise<WorkerHealthInfo[]> {
    try {
      const workerIds = await redis.smembers(ACTIVE_SET_KEY);
      if (workerIds.length === 0) return [];

      const results = await Promise.all(
        workerIds.map(async (workerId) => {
          const [info, heartbeat] = await Promise.all([
            redis.hgetall(`${INFO_KEY_PREFIX}${workerId}`),
            redis.get(`${HEARTBEAT_KEY_PREFIX}${workerId}`),
          ]);

          const jobsProcessed = Number(info.jobsProcessed ?? 0);
          const jobsCompleted = Number(info.jobsCompleted ?? 0);
          const jobsFailed = Number(info.jobsFailed ?? 0);

          const entry: WorkerHealthInfo = {
            workerId,
            jobsProcessed,
            jobsCompleted,
            jobsFailed,
            successRate: jobsProcessed > 0 ? Math.round((jobsCompleted / jobsProcessed) * 1000) / 10 : 0,
            startedAt: info.startedAt || new Date().toISOString(),
            lastHeartbeat: info.lastHeartbeat || '',
            lastJobAt: info.lastJobAt || null,
            isHealthy: heartbeat !== null,
          };
          return entry;
        }),
      );

      return results.sort((a, b) => b.jobsProcessed - a.jobsProcessed);
    } catch (err) {
      console.warn('[WorkerHealthReporter] getActiveWorkers failed:', (err as Error).message);
      return [];
    }
  }
}
