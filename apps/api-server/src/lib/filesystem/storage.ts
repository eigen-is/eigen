import {type BunFile, type S3File} from 'bun';

export interface Storage {
    uploadFile(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<void>;
    getFile(pathId: string): S3File | BunFile;
    deleteFile(pathId: string): Promise<void>;
    fileExists(pathId: string): Promise<boolean>;
}
    