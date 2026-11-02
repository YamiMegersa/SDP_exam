/**
 * Tracks the newest simulated timestamp seen per service.
 *
 * Envelope `ts` is simulator time; the platform's operator actions (acknowledge, resolve) are stamped
 * with it so the audit trail lines up with the data during replay. When nothing has been seen yet the
 * wall clock is used as a fallback.
 */
export class SimClock {
  private readonly latest = new Map<string, number>();
  private newest = 0;

  observe(service: string, ts: number): void {
    if (!Number.isFinite(ts)) return;
    const current = this.latest.get(service) ?? 0;
    if (ts > current) this.latest.set(service, ts);
    if (ts > this.newest) this.newest = ts;
  }

  forService(service: string): number {
    return this.latest.get(service) ?? Date.now();
  }

  /** Newest simulated time across all services, or the wall clock when nothing has arrived. */
  now(): number {
    return this.newest > 0 ? this.newest : Date.now();
  }

  known(): boolean {
    return this.newest > 0;
  }
}
