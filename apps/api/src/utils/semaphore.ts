// Counting semaphore: bounds how many run() bodies execute concurrently. Used to cap
// concurrent storage uploads so a throttling backend isn't slammed with parallel PUTs.
export class Semaphore {
    private active = 0;
    private waiters: (() => void)[] = [];

    constructor(private readonly max: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
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
