// A small settings object kept in one JSON file, such as a home's settings or the server settings.
// It loads the file once, serves reads from memory and saves the whole object again on every change.
// A change deep-merges into what is there, so a caller sends only the fields it changes.

import type { DeepPartial } from '@workspace/lib/types/util';
import type { LocalFilesystem } from './local-filesystem';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const sourceVal = source[key];
        const targetVal = result[key];
        result[key] =
            isPlainObject(sourceVal) && isPlainObject(targetVal) ? deepMerge(targetVal, sourceVal) : sourceVal;
    }
    return result;
}

// deepMerge works on untyped records. This is the one place that says the result is still a T.
function merge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
    return deepMerge(target, source) as T;
}

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
            this.data = merge(this.defaults, await file.json());
        }
    }

    public get(): T {
        return this.data;
    }

    // Memory shows a change only once it is on disk, so a failed save changes nothing.
    public set(update: DeepPartial<T>): Promise<T> {
        const run = this.writes.then(async () => {
            const next = merge(this.data, update);
            await this.fs.writeAtomic(this.filename, JSON.stringify(next, null, 2));
            this.data = next;
            return next;
        });
        this.writes = run.catch(() => {});
        return run;
    }
}
