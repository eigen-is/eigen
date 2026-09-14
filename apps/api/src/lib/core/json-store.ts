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

// deepMerge works on untyped records; only this seam asserts the merged shape is still a T.
function merge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
    return deepMerge(target, source) as T;
}

export class JsonStore<T extends Record<string, unknown>> {
    private data: T;

    constructor(
        private fs: LocalFilesystem,
        private filename: string,
        private defaults: T,
    ) {
        this.data = { ...defaults };
    }

    async load(): Promise<void> {
        const file = this.fs.file(this.filename);
        // Fail-closed: a corrupt existing file must reject, or the next set() persists defaults over the real bytes.
        if (await file.exists()) {
            this.data = merge(this.defaults, await file.json());
        }
    }

    get(): T {
        return this.data;
    }

    async set(update: DeepPartial<T>): Promise<T> {
        const prev = this.data;
        this.data = merge(this.data, update);
        try {
            await this.save();
        } catch (e) {
            this.data = prev;
            throw e;
        }
        return this.data;
    }

    private async save(): Promise<void> {
        const json = JSON.stringify(this.data, null, 2);
        const tmpFile = `${this.filename}.tmp`;
        await this.fs.write(tmpFile, json);
        await this.fs.rename(tmpFile, this.filename);
    }
}
