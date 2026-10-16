import "server-only";

/**
 * Provider-neutral pacing primitives shared by the Gmail and HubSpot clients.
 * An injectable Clock keeps pacing, backoff and run deadlines testable with a
 * virtual clock.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Spaces requests so that, on average, no more than `unitsPerSecond` quota
 * units are spent. Shared by all workers of one sync run; `pauseUntil` lets a
 * rate-limit backoff stall every worker, not just the one that was throttled.
 */
export class QuotaPacer {
  private nextFreeAt = 0;

  constructor(
    readonly unitsPerSecond: number,
    private readonly clock: Clock = realClock,
  ) {}

  async acquire(units: number): Promise<void> {
    if (!Number.isFinite(this.unitsPerSecond)) return;
    const now = this.clock.now();
    const start = Math.max(now, this.nextFreeAt);
    this.nextFreeAt = start + (units / this.unitsPerSecond) * 1000;
    if (start > now) await this.clock.sleep(start - now);
  }

  pauseUntil(at: number): void {
    this.nextFreeAt = Math.max(this.nextFreeAt, at);
  }
}
