/** Options accepted by every {@link TaskQueueError} subclass constructor. */
export interface TaskQueueErrorOptions {
  code: string;
  isRetryable: boolean;
  httpStatusCode?: number;
  cause?: Error;
}

/**
 * Base class for all task queue errors. Distinguishes retryable failures from
 * permanent ones so the worker can decide whether to retry a job or send it
 * straight to the dead letter queue.
 */
export class TaskQueueError extends Error {
  public readonly code: string;
  public readonly isRetryable: boolean;
  public readonly httpStatusCode: number;
  public readonly timestamp: string;

  constructor(message: string, options: TaskQueueErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code;
    this.isRetryable = options.isRetryable;
    this.httpStatusCode = options.httpStatusCode ?? 500;
    this.timestamp = new Date().toISOString();
  }
}

export interface TransientErrorOptions {
  code?: string;
  retryAfterMs?: number;
  cause?: Error;
}

/**
 * A transient/temporary failure that SHOULD be retried — network timeouts,
 * a service that's briefly unavailable, being rate limited by an external API.
 */
export class TransientError extends TaskQueueError {
  public readonly retryAfterMs?: number;

  constructor(message: string, options: TransientErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'TRANSIENT_ERROR',
      isRetryable: true,
      httpStatusCode: 503,
      cause: options.cause,
    });
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface PermanentErrorOptions {
  code?: string;
  cause?: Error;
}

/**
 * A permanent failure — retrying will NOT help. Invalid payloads, unsupported
 * formats, missing resources, failed authentication.
 */
export class PermanentError extends TaskQueueError {
  constructor(message: string, options: PermanentErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'PERMANENT_ERROR',
      isRetryable: false,
      httpStatusCode: 422,
      cause: options.cause,
    });
  }
}

/** An external service failed to respond in time. */
export class TimeoutError extends TransientError {
  public readonly timeoutMs: number;

  constructor(service: string, timeoutMs: number, options: { cause?: Error } = {}) {
    super(`${service} timed out after ${timeoutMs}ms`, {
      code: 'TIMEOUT_ERROR',
      cause: options.cause,
    });
    this.timeoutMs = timeoutMs;
  }
}

/** Rate limited by an external service. */
export class RateLimitError extends TransientError {
  constructor(service: string, retryAfterMs: number, options: { cause?: Error } = {}) {
    super(`${service} rate limit exceeded`, {
      code: 'RATE_LIMIT_ERROR',
      retryAfterMs,
      cause: options.cause,
    });
  }
}

/** Input validation failed inside a processor — bad input won't fix itself on retry. */
export class ValidationError extends PermanentError {
  public readonly field?: string;

  constructor(message: string, field?: string, options: { cause?: Error } = {}) {
    super(message, { code: 'VALIDATION_ERROR', cause: options.cause });
    this.field = field;
  }
}

/** A required resource doesn't exist. */
export class ResourceNotFoundError extends PermanentError {
  constructor(resource: string, identifier: string, options: { cause?: Error } = {}) {
    super(`${resource} '${identifier}' not found`, {
      code: 'RESOURCE_NOT_FOUND',
      cause: options.cause,
    });
  }
}
