export type Clock = () => number;

type UserWindow = { startedAt: number; count: number };

export type SuggestionPermit = { userId: string };

export class ExerciseSuggestionLimiter {
  private readonly users = new Map<string, UserWindow>();
  private inFlight = 0;
  private failures = 0;
  private circuitOpenedAt: number | null = null;
  private halfOpenInFlight = false;

  constructor(
    private readonly options: {
      now?: Clock;
      userLimit?: number;
      windowMs?: number;
      globalLimit?: number;
      circuitFailureLimit?: number;
      circuitOpenMs?: number;
      maxUsers?: number;
    } = {},
  ) {}

  tryAcquire(userId: string): SuggestionPermit | null {
    const now = this.now();
    this.prune(now);
    if (this.isCircuitOpen(now)) return null;
    if (this.inFlight >= (this.options.globalLimit ?? 3)) return null;

    const key = userId.trim();
    if (!key) return null;
    const windowMs = this.options.windowMs ?? 60_000;
    const current = this.users.get(key);
    if (current && now - current.startedAt < windowMs && current.count >= (this.options.userLimit ?? 5)) {
      return null;
    }
    if (!current && this.users.size >= (this.options.maxUsers ?? 10_000)) return null;

    if (current && now - current.startedAt < windowMs) {
      current.count += 1;
    } else {
      this.users.set(key, { startedAt: now, count: 1 });
    }
    this.inFlight += 1;
    if (this.circuitOpenedAt !== null) this.halfOpenInFlight = true;
    return { userId: key };
  }

  release(permit: SuggestionPermit, outcome: 'success' | 'failure' | 'unavailable'): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.circuitOpenedAt !== null && this.halfOpenInFlight) {
      this.halfOpenInFlight = false;
      if (outcome === 'success') {
        this.circuitOpenedAt = null;
        this.failures = 0;
      } else if (outcome === 'failure') {
        // A failed half-open probe starts a fresh open interval. Without this
        // reset, every subsequent request after the first interval could probe.
        this.circuitOpenedAt = this.now();
      }
      return;
    }
    if (outcome === 'failure') {
      this.failures += 1;
      if (this.failures >= (this.options.circuitFailureLimit ?? 5)) {
        this.circuitOpenedAt = this.now();
      }
    } else if (outcome === 'success') {
      this.failures = 0;
    }
    void permit;
  }

  get snapshot() {
    return {
      inFlight: this.inFlight,
      users: this.users.size,
      failures: this.failures,
      circuitOpen: this.circuitOpenedAt !== null,
    };
  }

  private isCircuitOpen(now: number): boolean {
    if (this.circuitOpenedAt === null) return false;
    const elapsed = now - this.circuitOpenedAt;
    if (elapsed < (this.options.circuitOpenMs ?? 60_000)) return true;
    if (this.halfOpenInFlight) return true;
    return false;
  }

  private prune(now: number): void {
    const windowMs = this.options.windowMs ?? 60_000;
    for (const [key, window] of this.users) {
      if (now - window.startedAt >= windowMs) this.users.delete(key);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
