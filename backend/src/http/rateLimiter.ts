import {createHash} from 'node:crypto';

import type {Pool} from 'pg';

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

export interface RateLimiter {
  isAllowed(ip: string, now?: number): boolean | Promise<boolean>;
}

/**
 * Process-local sliding-window limiter for development and host tests.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly requestsByIp = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
  }

  isAllowed(ip: string, now: number = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const timestamps = this.requestsByIp.get(ip) ?? [];

    const activeTimestamps = timestamps.filter(t => t > windowStart);

    if (activeTimestamps.length >= this.maxRequests) {
      this.requestsByIp.set(ip, activeTimestamps);
      return false;
    }

    activeTimestamps.push(now);
    this.requestsByIp.set(ip, activeTimestamps);
    return true;
  }

  reset(): void {
    this.requestsByIp.clear();
  }
}

/**
 * PostgreSQL-backed distributed sliding-window approximation.
 *
 * It stores only a SHA-256 digest of the client identifier and atomically
 * increments a fixed bucket. The current bucket is combined with the previous
 * bucket proportionally to elapsed time, so separate Neon/Node instances share
 * one enforcement state without persisting raw client IP addresses.
 */
export class PostgresSlidingWindowRateLimiter implements RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private lastCleanupWindow: number | null = null;

  constructor(
    private readonly pool: Pool,
    options: RateLimiterOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
  }

  async isAllowed(ip: string, now: number = Date.now()): Promise<boolean> {
    const bucketKey = createHash('sha256').update(ip || 'unknown', 'utf8').digest('hex');
    const currentWindow = Math.floor(now / this.windowMs) * this.windowMs;
    const previousWindow = currentWindow - this.windowMs;
    const elapsed = now - currentWindow;

    const current = await this.pool.query<{request_count: number | string}>(
      `INSERT INTO request_rate_limit_windows(bucket_key, window_start_ms, request_count, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (bucket_key, window_start_ms)
       DO UPDATE SET request_count = request_rate_limit_windows.request_count + 1, updated_at = NOW()
       RETURNING request_count`,
      [bucketKey, currentWindow],
    );

    const previous = await this.pool.query<{request_count: number | string}>(
      `SELECT request_count
       FROM request_rate_limit_windows
       WHERE bucket_key = $1 AND window_start_ms = $2`,
      [bucketKey, previousWindow],
    );

    if (this.lastCleanupWindow !== currentWindow) {
      this.lastCleanupWindow = currentWindow;
      const retentionCutoff = currentWindow - this.windowMs * 10;
      await this.pool.query(
        'DELETE FROM request_rate_limit_windows WHERE window_start_ms < $1',
        [retentionCutoff],
      );
    }

    const currentCount = Number(current.rows[0]?.request_count ?? 0);
    const previousCount = Number(previous.rows[0]?.request_count ?? 0);
    const previousWeight = Math.max(0, 1 - elapsed / this.windowMs);
    const estimatedSlidingCount = currentCount + previousCount * previousWeight;

    return estimatedSlidingCount <= this.maxRequests;
  }
}
