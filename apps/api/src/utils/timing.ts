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

// Whether `promise` settles (a rejection counts) within `ms`; the timer never outlives the answer.
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = promise.then(
        () => true,
        () => true,
    );
    try {
        return await Promise.race([
            settled,
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
