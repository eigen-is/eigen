import {type BunFile, type S3File} from 'bun';

export interface Storage {
    write(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<boolean>;

    file(pathId: string): S3File | BunFile;

    delete(pathId: string): Promise<boolean>;

    exists(pathId: string): Promise<boolean>;

// only used for local, directory based, storage:

    // mkdir(pathId: string, name: string): Promise<boolean>;

    // move(pathId: string, newParentId: string): Promise<boolean>;

    // rename(pathId: string, name: string): Promise<boolean>;
}
    