import type { Redis } from 'ioredis';

/**
 * Metrics Engine — Time-Series Data Collection in Redis
 *
 * Data model:
 *   1. COUNTERS    `metrics:counter:{name}`      — simple incrementing integer.
 *   2. TIME-SERIES `metrics:ts:{name}:{bucket}`   — value bucketed by minute/hour/day.
 *      Bucket formats (all derived from `Date#toISOString`, so lexically sortable):
 *        minute "2026-07-23T10:30", hour "2026-07-23T10", day "2026-07-23".
 *      Every `recordTimeSeries` call writes all three granularities at once, so a
 *      single event feeds the "last hour" (minute resolution), "last 24h" (hour
 *      resolution), and "last 7 days" (day resolution) views without re-aggregation.
 *   3. HISTOGRAMS  `metrics:hist:{name}`          — a capped Redis LIST of raw
 *      samples (newest at the tail), used to compute min/max/avg/percentiles.
 *      A list (not a sorted set keyed by value) is what makes "keep the most
 *      recent N samples" a plain `LTRIM`, and duplicate values need no unique
 *      member id the way a sorted-set member would.
 *   4. GAUGES      `metrics:gauge:{name}`         — current point-in-time value.
 *
 * Every public method swallows its own errors (logs a warning, returns a safe
 * default) — metrics collection must never throw into, delay, or crash a
 * caller that's on the hot path of processing a real job.
 */

export const METRICS_CONFIG = {
  KEY_PREFIX: 'metrics:',
  COUNTER_PREFIX: 'metrics:counter:',
  TIMESERIES_PREFIX: 'metrics:ts:',
  HISTOGRAM_PREFIX: 'metrics:hist:',
  GAUGE_PREFIX: 'metrics:gauge:',

  MINUTE_BUCKET_TTL: 7200, // 2 hours
  HOUR_BUCKET_TTL: 172800, // 48 hours
  DAY_BUCKET_TTL: 5184000, // 60 days

  HISTOGRAM_MAX_SAMPLES: 1000,
} as const;

export type TimeSeriesWindow = 'hour' | 'day' | 'week';

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface HistogramSummary {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

const EMPTY_HISTOGRAM_SUMMARY: HistogramSummary = { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };

export class MetricsCollector {
  constructor(private readonly redis: Redis) {}

  // === COUNTERS ===

  async incrementCounter(name: string, amount = 1): Promise<number> {
    try {
      return await this.redis.incrby(`${METRICS_CONFIG.COUNTER_PREFIX}${name}`, amount);
    } catch (err) {
      this.warn('incrementCounter', name, err);
      return 0;
    }
  }

  async getCounter(name: string): Promise<number> {
    try {
      const raw = await this.redis.get(`${METRICS_CONFIG.COUNTER_PREFIX}${name}`);
      return Number(raw ?? 0);
    } catch (err) {
      this.warn('getCounter', name, err);
      return 0;
    }
  }

  /**
   * Reads every counter whose name starts with `prefix` (e.g. all
   * `error_code_*` counters) as a map of the *unprefixed* suffix to its
   * value — used where the set of counter names is dynamic (per error code,
   * per job type) rather than known upfront. Uses `KEYS` rather than `SCAN`:
   * fine at this project's key-count scale, called from an admin-facing
   * analytics endpoint at most a few times a minute.
   */
  async getCountersByPrefix(prefix: string): Promise<Record<string, number>> {
    try {
      const pattern = `${METRICS_CONFIG.COUNTER_PREFIX}${prefix}*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) return {};

      const values = await this.redis.mget(...keys);
      const result: Record<string, number> = {};
      keys.forEach((key, i) => {
        const suffix = key.slice(`${METRICS_CONFIG.COUNTER_PREFIX}${prefix}`.length);
        result[suffix] = Number(values[i] ?? 0);
      });
      return result;
    } catch (err) {
      this.warn('getCountersByPrefix', prefix, err);
      return {};
    }
  }

  // === TIME SERIES ===

  /** Records a value into the current minute/hour/day buckets for `name`. */
  async recordTimeSeries(name: string, value = 1): Promise<void> {
    try {
      const now = new Date();
      const minuteKey = `${METRICS_CONFIG.TIMESERIES_PREFIX}${name}:${this.getMinuteBucket(now)}`;
      const hourKey = `${METRICS_CONFIG.TIMESERIES_PREFIX}${name}:${this.getHourBucket(now)}`;
      const dayKey = `${METRICS_CONFIG.TIMESERIES_PREFIX}${name}:${this.getDayBucket(now)}`;

      const pipeline = this.redis.pipeline();
      pipeline.incrby(minuteKey, value);
      pipeline.expire(minuteKey, METRICS_CONFIG.MINUTE_BUCKET_TTL);
      pipeline.incrby(hourKey, value);
      pipeline.expire(hourKey, METRICS_CONFIG.HOUR_BUCKET_TTL);
      pipeline.incrby(dayKey, value);
      pipeline.expire(dayKey, METRICS_CONFIG.DAY_BUCKET_TTL);
      await pipeline.exec();
    } catch (err) {
      this.warn('recordTimeSeries', name, err);
    }
  }

  /**
   * Reads back a chronological series for `name` at the resolution implied by
   * `window` — computing each bucket key directly (no Redis SCAN needed):
   *   'hour' → last 60 one-minute buckets
   *   'day'  → last 24 one-hour buckets
   *   'week' → last 7 one-day buckets
   */
  async getTimeSeries(name: string, window: TimeSeriesWindow): Promise<TimeSeriesPoint[]> {
    try {
      const now = Date.now();
      let buckets: string[];

      if (window === 'hour') {
        buckets = Array.from({ length: 60 }, (_, i) => this.getMinuteBucket(new Date(now - (59 - i) * 60_000)));
      } else if (window === 'day') {
        buckets = Array.from({ length: 24 }, (_, i) => this.getHourBucket(new Date(now - (23 - i) * 3_600_000)));
      } else {
        buckets = Array.from({ length: 7 }, (_, i) => this.getDayBucket(new Date(now - (6 - i) * 86_400_000)));
      }

      const keys = buckets.map((b) => `${METRICS_CONFIG.TIMESERIES_PREFIX}${name}:${b}`);
      const values = keys.length > 0 ? await this.redis.mget(...keys) : [];
      return buckets.map((timestamp, i) => ({ timestamp, value: Number(values[i] ?? 0) }));
    } catch (err) {
      this.warn('getTimeSeries', name, err);
      return [];
    }
  }

  // === HISTOGRAMS ===

  async recordHistogram(name: string, value: number): Promise<void> {
    try {
      const key = `${METRICS_CONFIG.HISTOGRAM_PREFIX}${name}`;
      const pipeline = this.redis.pipeline();
      pipeline.rpush(key, value);
      pipeline.ltrim(key, -METRICS_CONFIG.HISTOGRAM_MAX_SAMPLES, -1);
      await pipeline.exec();
    } catch (err) {
      this.warn('recordHistogram', name, err);
    }
  }

  async getHistogramSummary(name: string): Promise<HistogramSummary> {
    try {
      const key = `${METRICS_CONFIG.HISTOGRAM_PREFIX}${name}`;
      const raw = await this.redis.lrange(key, 0, -1);
      const values = raw.map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      if (values.length === 0) return { ...EMPTY_HISTOGRAM_SUMMARY };

      const sum = values.reduce((acc, v) => acc + v, 0);
      return {
        count: values.length,
        min: values[0],
        max: values[values.length - 1],
        avg: Math.round(sum / values.length),
        p50: this.percentile(values, 50),
        p95: this.percentile(values, 95),
        p99: this.percentile(values, 99),
      };
    } catch (err) {
      this.warn('getHistogramSummary', name, err);
      return { ...EMPTY_HISTOGRAM_SUMMARY };
    }
  }

  // === SETS (membership tracking — e.g. which error codes are retryable) ===

  async addToSet(name: string, member: string): Promise<void> {
    try {
      await this.redis.sadd(`${METRICS_CONFIG.KEY_PREFIX}set:${name}`, member);
    } catch (err) {
      this.warn('addToSet', name, err);
    }
  }

  async getSet(name: string): Promise<string[]> {
    try {
      return await this.redis.smembers(`${METRICS_CONFIG.KEY_PREFIX}set:${name}`);
    } catch (err) {
      this.warn('getSet', name, err);
      return [];
    }
  }

  // === GAUGES ===

  async setGauge(name: string, value: number): Promise<void> {
    try {
      await this.redis.set(`${METRICS_CONFIG.GAUGE_PREFIX}${name}`, value);
    } catch (err) {
      this.warn('setGauge', name, err);
    }
  }

  async getGauge(name: string): Promise<number> {
    try {
      const raw = await this.redis.get(`${METRICS_CONFIG.GAUGE_PREFIX}${name}`);
      return Number(raw ?? 0);
    } catch (err) {
      this.warn('getGauge', name, err);
      return 0;
    }
  }

  // === HELPERS ===

  private getMinuteBucket(date: Date): string {
    return date.toISOString().slice(0, 16); // "2026-07-23T10:30"
  }

  private getHourBucket(date: Date): string {
    return date.toISOString().slice(0, 13); // "2026-07-23T10"
  }

  private getDayBucket(date: Date): string {
    return date.toISOString().slice(0, 10); // "2026-07-23"
  }

  /** Nearest-rank percentile over an already-sorted ascending array. */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.min(Math.max(rank, 0), sortedValues.length - 1)];
  }

  private warn(op: string, name: string, err: unknown): void {
    console.warn(`[MetricsCollector] ${op}("${name}") failed:`, (err as Error)?.message ?? err);
  }
}
