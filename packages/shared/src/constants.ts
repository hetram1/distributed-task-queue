/**
 * Queue and worker configuration shared by the API server (producer) and the
 * worker package (consumer) — the single source of truth for the queue name
 * so it is never hardcoded in either package.
 */
export const QUEUE_CONFIG = {
  QUEUE_NAME: 'task-queue-main',
  DEFAULT_CONCURRENCY: 3,
  LOCK_DURATION: 60000,
  STALLED_INTERVAL: 30000,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_DURATION: 1000,
  /** Furthest into the future a `delay`/`scheduledAt` may push a job (7 days). */
  MAX_JOB_DELAY_MS: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Retry/backoff tuning and dead letter queue configuration — the single
 * source of truth for both the API server (job submission) and the worker
 * (custom backoff strategy + DLQ). `MAX_ATTEMPTS` supersedes the old
 * `QUEUE_CONFIG.DEFAULT_MAX_ATTEMPTS`.
 */
export const RETRY_CONFIG = {
  /** Total attempts allowed: 1 initial + 4 retries. */
  MAX_ATTEMPTS: 5,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 60000,
  BACKOFF_MULTIPLIER: 2,
  /** Adds ±25% randomness to each delay to avoid a "thundering herd" of retries firing at once. */
  JITTER: true,

  DLQ_QUEUE_NAME: 'task-queue-dlq',
  DLQ_RETENTION_DAYS: 7,

  /** Redis key prefix for per-job retry history — see packages/worker/src/retry-tracker.ts. */
  RETRY_HISTORY_KEY_PREFIX: 'job:retry-history:',
} as const;

/**
 * Exponential backoff delay for a given attempt number, capped at MAX_DELAY_MS,
 * with optional jitter: attempt 1 → 1000ms, 2 → 2000ms, 3 → 4000ms, 4 → 8000ms, ...
 */
export function calculateBackoffDelay(attempt: number): number {
  const exponential = RETRY_CONFIG.INITIAL_DELAY_MS * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, RETRY_CONFIG.MAX_DELAY_MS);

  if (!RETRY_CONFIG.JITTER) {
    return Math.round(capped);
  }

  const jitterFactor = 1 + (Math.random() * 0.5 - 0.25);
  return Math.round(Math.min(Math.max(capped * jitterFactor, 0), RETRY_CONFIG.MAX_DELAY_MS));
}

/** Job priority — lower numeric value is processed first. */
export enum JobPriority {
  CRITICAL = 1,
  HIGH = 2,
  NORMAL = 3,
  LOW = 4,
}

/** Job types supported by the system. */
export enum JobType {
  IMAGE_RESIZE = 'IMAGE_RESIZE',
  EMAIL_SEND = 'EMAIL_SEND',
  PDF_GENERATE = 'PDF_GENERATE',
  WEBHOOK_DELIVER = 'WEBHOOK_DELIVER',
  DATA_EXPORT = 'DATA_EXPORT',
}

/** Job lifecycle status. */
export enum JobStatus {
  QUEUED = 'queued',
  /** Scheduled for later via `delay`/`scheduledAt`, not yet due — distinct from a retry backoff wait. */
  DELAYED = 'delayed',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD = 'dead',
}

/** Human-readable label for each priority level. */
export const PRIORITY_LABELS: Record<JobPriority, string> = {
  [JobPriority.CRITICAL]: 'CRITICAL',
  [JobPriority.HIGH]: 'HIGH',
  [JobPriority.NORMAL]: 'NORMAL',
  [JobPriority.LOW]: 'LOW',
};

/** Returns the human-readable label for a priority value, or 'UNKNOWN' for an unrecognized one. */
export function getPriorityLabel(priority: JobPriority): string {
  return PRIORITY_LABELS[priority] ?? 'UNKNOWN';
}

/** Default BullMQ job options applied to every job added to the queue. */
export const DEFAULT_JOB_OPTIONS = {
  REMOVE_ON_COMPLETE: 100,
  REMOVE_ON_FAIL: 500,
} as const;

/**
 * Redis key layout for scheduler (cron/recurring job) metadata — the
 * management layer the API server keeps on top of BullMQ's built-in job
 * schedulers, and that the worker writes run stats/history into.
 */
export const SCHEDULER_CONFIG = {
  METADATA_KEY_PREFIX: 'scheduler:meta:',
  STATS_KEY_PREFIX: 'scheduler:stats:',
  RUNS_KEY_PREFIX: 'scheduler:runs:',
  INDEX_KEY: 'scheduler:index',
  ID_COUNTER_KEY: 'scheduler:id-counter',
  /** How many recent run records to keep per scheduled job. */
  RUN_HISTORY_LIMIT: 50,
  /** TTL applied (lazily, once a schedule is observed as completed/expired) so old metadata doesn't accumulate forever. */
  METADATA_TTL_DAYS: 30,
} as const;

/** Default pagination values for list endpoints. */
export const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

/**
 * Distributed lock configuration — used by `DistributedLockManager`
 * (packages/shared/src/lock-manager.ts), instantiated independently by both
 * the worker (acquires/releases locks while processing) and the API server
 * (reads/force-releases locks for the admin endpoints). Lives here rather
 * than in either package because it has no BullMQ dependency.
 */
export const LOCK_CONFIG = {
  DEFAULT_TTL_MS: 30000,
  DEFAULT_ACQUIRE_TIMEOUT_MS: 10000,
  DEFAULT_RETRY_INTERVAL_MS: 200,
  KEY_PREFIX: 'lock:',
  META_PREFIX: 'lock:meta:',
  REGISTRY_KEY: 'lock:registry',
  STATS_KEY: 'lock:stats',
} as const;

/** Per-job-type concurrency limits, enforced across all worker processes via Redis counters. */
export const CONCURRENCY_CONFIG = {
  KEY_PREFIX: 'concurrency:',
  LIMITS: {
    IMAGE_RESIZE: 3,
    EMAIL_SEND: 10,
    PDF_GENERATE: 2,
    WEBHOOK_DELIVER: 5,
    DATA_EXPORT: 2,
  } as Record<string, number>,
} as const;

/** API-level idempotency key configuration — see packages/api-server/src/services/idempotency.service.ts. */
export const IDEMPOTENCY_CONFIG = {
  KEY_PREFIX: 'idempotency:',
  DEFAULT_TTL_SECONDS: 86400,
  MAX_KEY_LENGTH: 256,
  STATS_KEY: 'idempotency:stats',
} as const;

/** Worker-level completed-job deduplication — see packages/worker/src/dedup-checker.ts. */
export const DEDUP_CONFIG = {
  KEY_PREFIX: 'dedup:completed:',
  DEFAULT_TTL_SECONDS: 3600,
} as const;
