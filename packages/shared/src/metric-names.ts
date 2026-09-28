/**
 * All metric names used in the system, centralized to prevent typos and
 * ensure the worker (writer) and API server (reader) always agree.
 */
export const METRIC_NAMES = {
  // === Counters (running totals, never reset) ===
  JOBS_SUBMITTED: 'jobs_submitted',
  JOBS_COMPLETED: 'jobs_completed',
  JOBS_FAILED: 'jobs_failed',
  JOBS_RETRIED: 'jobs_retried',
  JOBS_DEAD_LETTERED: 'jobs_dead_lettered',
  DUPLICATES_PREVENTED: 'duplicates_prevented',
  LOCKS_ACQUIRED: 'locks_acquired',
  LOCKS_CONTENDED: 'locks_contended',

  /** Prefix + JobType → total completed for that type, e.g. `type_completed_EMAIL_SEND`. */
  TYPE_COMPLETED_PREFIX: 'type_completed_',
  /** Prefix + JobType → total failed attempts for that type. */
  TYPE_FAILED_PREFIX: 'type_failed_',
  /** Prefix + error code → total occurrences, e.g. `error_code_VALIDATION_ERROR`. */
  ERROR_CODE_PREFIX: 'error_code_',
  ERRORS_RETRYABLE: 'errors_retryable',
  ERRORS_PERMANENT: 'errors_permanent',
  /** Set names (via addToSet/getSet) recording which error codes have been observed as retryable vs. permanent, so the errors endpoint can label each code without a hardcoded lookup table. */
  RETRYABLE_ERROR_CODES_SET: 'retryable-error-codes',
  PERMANENT_ERROR_CODES_SET: 'permanent-error-codes',

  // === Time series (minute/hour/day buckets, written on every event) ===
  TS_JOBS_SUBMITTED: 'ts_jobs_submitted',
  TS_JOBS_COMPLETED: 'ts_jobs_completed',
  TS_JOBS_FAILED: 'ts_jobs_failed',
  /** Total jobs processed (completed + failed) per time bucket. */
  TS_THROUGHPUT: 'ts_throughput',

  /** Prefix + JobType + '_completed'|'_failed', e.g. `ts_type_EMAIL_SEND_completed`. */
  TS_TYPE_PREFIX: 'ts_type_',
  /** Prefix + workerId + '_completed', e.g. `ts_worker_worker-x7k2_completed`. */
  TS_WORKER_PREFIX: 'ts_worker_',

  // === Histograms (rolling sample window, for percentile calculation) ===
  PROCESSING_TIME_ALL: 'processing_time_all',
  /** Prefix + JobType, e.g. `processing_time_EMAIL_SEND`. */
  PROCESSING_TIME_PREFIX: 'processing_time_',
  /** Prefix + workerId, e.g. `processing_time_worker_worker-x7k2`. */
  PROCESSING_TIME_WORKER_PREFIX: 'processing_time_worker_',
  /** Time from job creation to a worker picking it up. */
  WAIT_TIME: 'wait_time',
  LOCK_HOLD_TIME: 'lock_hold_time',
  LOCK_WAIT_TIME: 'lock_wait_time',

  // === Gauges (current point-in-time values) ===
  ACTIVE_WORKERS: 'active_workers',
  QUEUE_DEPTH: 'queue_depth',
  ACTIVE_JOBS: 'active_jobs',
  DLQ_DEPTH: 'dlq_depth',
} as const;
