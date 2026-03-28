import type {LocalFilesystem} from './local-filesystem';

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

function deepMerge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
    const result = {...target};
    for (const key of Object.keys(source) as (keyof T)[]) {
        const sourceVal = source[key];
        const targetVal = result[key];
        if (
            sourceVal !== null &&
            sourceVal !== undefined &&
            typeof sourceVal === 'object' &&
            !Array.isArray(sourceVal) &&
            typeof targetVal === 'object' &&
            targetVal !== null &&
            !Array.isArray(targetVal)
        ) {
            result[key] = deepMerge(
                targetVal as Record<string, unknown>,
                sourceVal as DeepPartial<Record<string, unknown>>,
            ) as T[keyof T];
        } else {
            result[key] = sourceVal as T[keyof T];
        }
    }
    return result;
}

export class JsonStore<T extends Record<string, unknown>> {
    private data: T;

    constructor(
        private fs: LocalFilesystem,
        private filename: string,
        private defaults: T,
    ) {
        this.data = {...defaults};
    }

    async load(): Promise<void> {
        try {
            const file = this.fs.file(this.filename);
            if (await file.exists()) {
                this.data = deepMerge(this.defaults, (await file.json()) as DeepPartial<T>);
            }
        } catch {
            this.data = {...this.defaults};
        }
    }

    get(): T {
        return this.data;
    }

    async set(update: DeepPartial<T>): Promise<T> {
        const prev = this.data;
        this.data = deepMerge(this.data, update);
        try {
            await this.save();
        } catch (e) {
            this.data = prev;
            throw e;
        }
        return this.data;
    }

    async save(): Promise<void> {
        const json = JSON.stringify(this.data, null, 2);
        const tmpFile = `${this.filename}.tmp`;
        await this.fs.file(tmpFile).write(json);
        await this.fs.rename(tmpFile, this.filename);
    }
}
