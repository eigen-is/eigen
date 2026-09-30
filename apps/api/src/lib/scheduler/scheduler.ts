// In-process scheduler for periodic background work: setInterval with an optional run at start, error
// isolation, and one shutdown for all of it.

const timers: Timer[] = [];

// Runs fn immediately unless `atStart` is false, then every intervalMs. fn can return anything (sync or
// Promise) — the return value is discarded and rejections are caught + logged so
// one bad sweep never breaks the schedule. A slow async fn is never re-entered:
// a tick that fires while the previous sweep is still running is skipped.
export function scheduleInterval(
    name: string,
    intervalMs: number,
    fn: () => unknown,
    { atStart = true }: { atStart?: boolean } = {},
): void {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await fn();
        } catch (error) {
            console.error(`[scheduler] ${name} failed:`, error);
        } finally {
            running = false;
        }
    };
    if (atStart) run();
    const timer = setInterval(run, intervalMs);
    timer.unref(); // periodic work must never hold the process open at shutdown
    timers.push(timer);
}

export function stopAllSchedules(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
}
