import type {BunFile, S3File} from 'bun';

export type {S3Config} from '@workspace/lib/types';

export interface StorageBackend {
    read(key: string): BunFile | S3File;

    write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>;

    delete(key: string): Promise<boolean>;

    exists(key: string): Promise<boolean>;

    size(key: string): Promise<number | null>;

    getPath?(key: string): string;

    mkdir?(key: string): Promise<void>;

    rename?(oldKey: string, newKey: string): Promise<void>;

    deleteDir?(key: string): Promise<boolean>;
}
