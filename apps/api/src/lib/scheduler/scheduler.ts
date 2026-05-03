// Tiny in-process scheduler for periodic background work — wraps setInterval with
// kick-off-at-startup semantics, error isolation, and central shutdown.
//
// Why not Bun.cron: Bun.cron(scriptPath, expr, title) spawns a separate Bun process
// from a script file, which would mean recreating DB connections and the Home
// factory just to run a single function. setInterval keeps work in-process where
// the existing app state already lives. Use Bun.cron when we want a standalone
// script on a wall-clock schedule (e.g. nightly export to S3).

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
