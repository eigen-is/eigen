// The types of the storage layer: what a backend such as the local disk or an S3 bucket must offer, the
// file handle a read returns, and the forms a file's bytes arrive in for a write. The backends implement
// them, and a mount and the drive above it pass them along.

import type { BunFile, S3File } from 'bun';

export type { S3Config } from '@workspace/lib/types';

export type StorageFile = BunFile | S3File;

// A file's bytes as a write takes them: held in memory, read from storage or streamed from a request.
export type FileBytes = Buffer | Uint8Array | StorageFile | ReadableStream<Uint8Array>;

export interface StorageBackend {
    read(key: string): StorageFile;

    write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>;

    // true once the key is gone, a missing one included; false only when the call failed.
    delete(key: string): Promise<boolean>;

    exists(key: string): Promise<boolean>;

    size(key: string): Promise<number | null>;

    getPath?(key: string): string;

    mkdir?(key: string): Promise<void>;

    rename?(oldKey: string, newKey: string): Promise<void>;

    deleteDir?(key: string): Promise<boolean>;
}
