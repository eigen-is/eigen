import type {BunFile, S3File} from 'bun';

export type {S3Config} from '@workspace/lib/types';

export interface StorageBackend {
    read(fileId: string): BunFile | S3File;

    write(fileId: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number>;

    delete(fileId: string): Promise<boolean>;

    exists(fileId: string): Promise<boolean>;

    size(fileId: string): Promise<number | null>;

    getPath?(fileId: string): string;
}
