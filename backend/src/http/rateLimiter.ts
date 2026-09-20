export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

/**
 * Sliding-window in-memory rate limiter to protect backend emergency endpoints
 * from denial-of-service or brute-force enumeration.
 */
export class SlidingWindowRateLimiter {
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

    const activeTimestamps = timestamps.filter((t) => t > windowStart);

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
