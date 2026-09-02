import type { BunFile } from 'bun';
import { isProduction } from '../config/env';
import { ApiError } from '../core';
import type { StorageBackend, StorageFile } from './types';

type FaultKind = 'exists-throw' | 'exists-delay';

// Dev-only fault injection: every mount's backend delegates to the real one but fails or stalls on
// the exists() probe a create/open makes, so degraded-storage behaviour is reproducible without an
// outage. read()/readRange() are synchronous handle factories — the GET happens when Bun consumes
// the returned file, outside this class — so there is nothing to inject on the read path.
class StorageFaultInjector implements StorageBackend {
    // These must be present exactly when the inner backend has them: a mount reads getPath's
    // presence to pick the path-based vs temp-copy path, and mkdir/rename/deleteDir the same way.
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
        // 503 matches what document-db.ts raises for an unreachable storage object, so the failure
        // reaches Drive.create/openDatabase in the shape a real outage produces.
        if (this.kind === 'exists-throw') throw new ApiError(503, 'storage unavailable');
        await Bun.sleep(this.ms);
        return this.inner.exists(key);
    }

    async size(key: string): Promise<number | null> {
        return this.inner.size(key);
    }
}

// EIGEN_STORAGE_FAULT=exists-throw | exists-delay=<ms>. Never active in production, whatever the
// variable says.
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
