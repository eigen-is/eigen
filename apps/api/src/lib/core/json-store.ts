// A small settings object kept in one JSON file, such as a home's settings or the server settings.
// It loads the file once, serves reads from memory and saves the whole object again on every change.
// A change deep-merges into what is there, so a caller sends only the fields it changes.

import { deepMerge } from '@workspace/lib/deep-merge';
import type { DeepPartial } from '@workspace/lib/types/util';
import type { LocalFilesystem } from './local-filesystem';

export class JsonStore<T extends Record<string, unknown>> {
    private data: T;
    // Every set waits for the one before it. Two saves at once could otherwise each start from the
    // same old data, and the one that lands last would undo the other.
    private writes: Promise<unknown> = Promise.resolve();

    public constructor(
        private fs: LocalFilesystem,
        private filename: string,
        private defaults: T,
    ) {
        this.data = { ...defaults };
    }

    public async load(): Promise<void> {
        const file = this.fs.file(this.filename);
        // A file that doesn't parse makes load reject. Otherwise the next set would save the defaults over it.
        if (await file.exists()) {
            this.data = deepMerge(this.defaults, await file.json());
        }
    }

    public get(): T {
        return this.data;
    }

    // Memory shows a change only once it is on disk, so a failed save changes nothing.
    public set(update: DeepPartial<T>): Promise<T> {
        const run = this.writes.then(async () => {
            const next = deepMerge(this.data, update);
            await this.fs.writeAtomic(this.filename, JSON.stringify(next, null, 2));
            this.data = next;
            return next;
        });
        this.writes = run.catch(() => {});
        return run;
    }
}
