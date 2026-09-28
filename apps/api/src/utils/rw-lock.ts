// Reader/writer lock: any number of shared() bodies, or one exclusive() body. One FIFO queue, so a
// shared request never overtakes a queued exclusive. Not reentrant: a nested acquire can deadlock.
export class RWLock {
    private readers = 0;
    private writer = false;
    private waiters: { exclusive: boolean; grant: () => void }[] = [];

    async shared<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.writer && this.waiters.length === 0) {
            this.readers++;
        } else {
            await new Promise<void>((grant) => this.waiters.push({ exclusive: false, grant }));
        }
        try {
            return await fn();
        } finally {
            this.readers--;
            this.release();
        }
    }

    async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.writer && this.readers === 0 && this.waiters.length === 0) {
            this.writer = true;
        } else {
            await new Promise<void>((grant) => this.waiters.push({ exclusive: true, grant }));
        }
        try {
            return await fn();
        } finally {
            this.writer = false;
            this.release();
        }
    }

    // Counts are updated here, before the waiter resumes, so no request can slip in between.
    private release(): void {
        while (this.waiters.length > 0) {
            const next = this.waiters[0];
            if (this.writer || (next.exclusive && this.readers > 0)) return;
            this.waiters.shift();
            if (next.exclusive) this.writer = true;
            else this.readers++;
            next.grant();
        }
    }
}
