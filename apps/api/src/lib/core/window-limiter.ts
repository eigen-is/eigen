// A sliding window per key: a key is full once `max` of its hits fall inside the window. Process-local,
// fine while Eigen runs as one API process. A key is pruned only when touched, so a spray across
// thousands of keys would leave a dead one each; past SWEEP_ABOVE_KEYS a recorded hit drops them all.
const SWEEP_ABOVE_KEYS = 2000;

export class WindowLimiter {
    private hits = new Map<string, number[]>();

    constructor(
        private windowMs: number,
        private max: number,
    ) {}

    private fresh(key: string, now: number): number[] {
        const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (fresh.length > 0) this.hits.set(key, fresh);
        else this.hits.delete(key);
        return fresh;
    }

    isFull(key: string): boolean {
        return this.fresh(key, Date.now()).length >= this.max;
    }

    record(key: string): void {
        const now = Date.now();
        this.hits.set(key, [...this.fresh(key, now), now]);
        if (this.hits.size <= SWEEP_ABOVE_KEYS) return;
        // Hits go in oldest-first, so the last one dates the whole key.
        for (const [k, times] of this.hits) if (now - times[times.length - 1] >= this.windowMs) this.hits.delete(k);
    }

    // Records a hit when the key has room; false when it is full.
    take(key: string): boolean {
        if (this.isFull(key)) return false;
        this.record(key);
        return true;
    }

    release(key: string): void {
        this.hits.delete(key);
    }

    clear(): void {
        this.hits.clear();
    }
}
