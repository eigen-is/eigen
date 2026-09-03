import type { BunFile } from 'bun';
import { isProduction } from '../config/env';
import { ApiError } from '../core';
import type { StorageBackend, StorageFile } from './types';

type FaultKind = 'exists-throw' | 'exists-delay';

// Dev-only: fails or stalls the exists() probe every create/open makes, so degraded storage is
// reproducible without an outage. read()/readRange() hand out lazy handles, so nothing to inject there.
class StorageFaultInjector implements StorageBackend {
    // Present exactly when the inner backend has them — Mount branches on getPath's presence.
    readonly readRange: StorageBackend['readRange'];
    readonly getPath: StorageBackend['getPath'];
    readonly mkdir: StorageBackend['mkdir'];
    readonly rename: StorageBackend['rename'];
    readonly deleteDir: StorageBackend['deleteDir'];

    constructor(
        private readonly inner: StorageBackend,
        private readonly kind: FaultKind,
        private readonly ms: number,
    ) {
        this.readRange = inner.readRange?.bind(inner);
        this.getPath = inner.getPath?.bind(inner);
        this.mkdir = inner.mkdir?.bind(inner);
        this.rename = inner.rename?.bind(inner);
        this.deleteDir = inner.deleteDir?.bind(inner);
    }

    read(key: string): StorageFile {
        return this.inner.read(key);
    }

    write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        return this.inner.write(key, data);
    }

    delete(key: string): Promise<boolean> {
        return this.inner.delete(key);
    }

    async exists(key: string): Promise<boolean> {
        // Same 503 shape as a real outage (S3Storage.exists, document-db.ts).
        if (this.kind === 'exists-throw') throw new ApiError(503, 'storage unavailable');
        await Bun.sleep(this.ms);
        return this.inner.exists(key);
    }

    size(key: string): Promise<number | null> {
        return this.inner.size(key);
    }
}

// EIGEN_STORAGE_FAULT=exists-throw | exists-delay=<ms>; inert in production whatever the variable says.
export function wrapWithStorageFault(backend: StorageBackend): StorageBackend {
    const spec = process.env['EIGEN_STORAGE_FAULT'];
    if (!spec || isProduction()) return backend;
    const [kind, value] = spec.split('=');
    const ms = Number(value) || 0;
    if (kind === 'exists-throw' || (kind === 'exists-delay' && ms > 0)) {
        console.warn(`[storage] EIGEN_STORAGE_FAULT=${spec} — injecting storage faults (dev only)`);
        return new StorageFaultInjector(backend, kind, ms);
    }
    console.warn(`[storage] ignoring unrecognised EIGEN_STORAGE_FAULT=${spec}`);
    return backend;
}
