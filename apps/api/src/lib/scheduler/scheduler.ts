// Tiny in-process scheduler for periodic background work — wraps setInterval with
// kick-off-at-startup semantics, error isolation, and central shutdown.
//
// Future: recent Bun added in-process Bun.cron(schedule, handler) that runs the
// callback inside the current process with shared state — we could switch to it
// when we want wall-clock schedules (e.g. "every day at 03:00 UTC") instead of
// the millisecond intervals + kick-at-startup pattern this file gives us.

const timers: Timer[] = [];

// Runs fn immediately, then every intervalMs. fn can return anything (sync or
// Promise) — the return value is discarded and rejections are caught + logged so
// one bad sweep never breaks the schedule.
export function scheduleInterval(name: string, intervalMs: number, fn: () => unknown): void {
    const run = () => {
        Promise.resolve(fn()).catch((error) => console.error(`[scheduler] ${name} failed:`, error));
    };
    run();
    timers.push(setInterval(run, intervalMs));
}

export function stopAllSchedules(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
}
