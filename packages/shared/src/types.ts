import { JobPriority, JobStatus, JobType } from './constants';

/** Request body for submitting a new job. */
export interface CreateJobRequest {
  type: JobType;
  payload: Record<string, any>;
  priority?: JobPriority;
  /** Delay in milliseconds before the job becomes eligible for processing. Ignored if `scheduledAt` is also set. */
  delay?: number;
  /** ISO date string — process at this specific time. Takes precedence over `delay` if both are provided. */
  scheduledAt?: string;
  /** Client-provided deduplication key — a resubmission with the same key returns the original job instead of creating a duplicate. */
  idempotencyKey?: string;
}

/** Public representation of a job returned by the API. */
export interface JobResponse {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  result?: any;
  error?: string;
  /** Only present while status is 'delayed': the originally requested delay, in milliseconds. */
  delay?: number;
  /** Only present while status is 'delayed': ISO timestamp of when the job becomes eligible for processing. */
  scheduledFor?: string;
  /** Only present while status is 'delayed': milliseconds remaining until `scheduledFor`. */
  timeUntilProcessing?: number;
}

/** Envelope a processor returns/attaches once a job finishes, identifying which worker ran it. */
export interface JobResult {
  success: boolean;
  data: any;
  /** Milliseconds spent processing. */
  processingTime: number;
  workerId: string;
  completedAt: string;
}

/** One recorded attempt at processing a job — written by the worker's RetryTracker. */
export interface AttemptRecord {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  endedAt: string;
  /** Milliseconds spent on this attempt. */
  duration: number;
  status: 'completed' | 'failed';
  error?: {
    message: string;
    code: string;
    isRetryable: boolean;
  };
  /** Milliseconds waited before this attempt started (0 for the first attempt). */
  backoffDelay?: number;
}

/** Response for GET /api/v1/jobs/:id/retries. */
export interface RetryHistoryResponse {
  jobId: string;
  totalAttempts: number;
  maxAttempts: number;
  history: AttemptRecord[];
}

/**
 * Raw shape stored as a DLQ BullMQ job's data — written by the worker's
 * DeadLetterQueueManager, read by the API server's dlq.service. Both sides
 * agree on this shape via the shared type rather than duplicating it.
 */
export interface DLQEntry {
  originalJobId: string;
  originalJobType: JobType;
  originalPayload: Record<string, any>;
  originalQueue: string;
  finalError: {
    message: string;
    code: string;
    isRetryable: boolean;
    stack?: string;
  };
  totalAttempts: number;
  maxAttempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string;
  movedToDlqAt: string;
  expiresAt: string;
}

/** API-facing representation of a dead letter (DLQEntry minus internals like the stack trace, plus its DLQ id). */
export interface DLQJobResponse {
  dlqId: string;
  originalJobId: string;
  originalJobType: JobType;
  originalPayload: Record<string, any>;
  finalError: {
    message: string;
    code: string;
    isRetryable: boolean;
  };
  totalAttempts: number;
  maxAttempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string;
  movedToDlqAt: string;
  expiresAt: string;
}

/** Response for GET /api/v1/dlq/stats. */
export interface DLQStatsResponse {
  total: number;
  byType: Record<string, number>;
  byErrorCode: Record<string, number>;
  oldestEntry: string | null;
}

/** Schedule config as sent when creating/updating a recurring job. */
export interface ScheduleConfig {
  /** Cron expression, e.g. "0 9 * * *" (every day at 9am). */
  cron: string;
  /** IANA timezone, e.g. "Asia/Kolkata". Defaults to "UTC". */
  timezone?: string;
  /** Don't start producing runs before this date. */
  startDate?: string;
  /** Stop producing runs after this date. */
  endDate?: string;
  /** Maximum number of runs. */
  limit?: number;
}

/** Request body for POST /api/v1/scheduler. */
export interface CreateScheduledJobRequest {
  name: string;
  description?: string;
  type: JobType;
  /** Payload template used for every run this schedule produces. */
  payload: Record<string, any>;
  priority?: JobPriority;
  schedule: ScheduleConfig;
}

/** Public representation of a recurring job returned by the API. */
export interface ScheduledJobResponse {
  id: string;
  name: string;
  description?: string;
  type: JobType;
  payload: Record<string, any>;
  priority: JobPriority;
  schedule: {
    cron: string;
    /** Human-readable description of `cron`, e.g. "Every day at 9:00 AM". */
    cronHuman: string;
    timezone: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    /** ISO timestamp of the next run, or null if this schedule won't run again. */
    nextRunAt: string | null;
  };
  status: 'active' | 'paused' | 'completed' | 'expired';
  stats: {
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    lastRunAt?: string;
    nextRunAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

/** Aggregate run stats for a scheduled job — written by the worker, read by the API server. */
export interface SchedulerRunStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt?: string;
}

/** One run produced by a scheduled job, recorded by the worker. */
export interface ScheduledJobRun {
  jobId: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  /** Milliseconds spent processing. */
  duration: number;
  error?: string;
}

/** Response for GET /api/v1/scheduler/:id/history. */
export interface ScheduledJobRunHistoryResponse {
  scheduledJobId: string;
  runs: ScheduledJobRun[];
}

export interface PaginationQuery {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    message: string;
    code: string;
    statusCode: number;
  };
}
