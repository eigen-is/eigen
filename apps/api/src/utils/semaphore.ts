// Counting semaphore: bounds how many run() bodies execute concurrently. Used to cap
// concurrent storage uploads so a throttling backend isn't slammed with parallel PUTs.
export class Semaphore {
    private active = 0;
    private waiters: (() => void)[] = [];

    constructor(private readonly max: number) {}

    // The callers queued behind the running ones.
    get waiting(): number {
        return this.waiters.length;
    }

    // A waiter whose signal aborts leaves the queue and rejects with the signal's reason, so nothing it holds waits on.
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private async acquire(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.active < this.max) {
            this.active++;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter = () => {
                signal?.removeEventListener('abort', leave);
                resolve();
            };
            const leave = () => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(signal?.reason);
            };
            signal?.addEventListener('abort', leave, { once: true });
            this.waiters.push(waiter);
        });
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) {
            next(); // hand the slot straight to the next waiter; active count unchanged
        } else {
            this.active--;
        }
    }
}
