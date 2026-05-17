const SLOW_THRESHOLD_MS = 100;

export async function time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const start = Bun.nanoseconds();
    try {
        return await fn();
    } finally {
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        if (ms > SLOW_THRESHOLD_MS) {
            console.log(`[timing] ${label} ${ms.toFixed(1)}ms`);
        }
    }
}
