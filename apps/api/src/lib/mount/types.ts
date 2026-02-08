import type {S3Config} from '../storage';

export type MountConfig = {
    id: string;
    name: string;
    storageType: 'local-key' | 's3' | 'local';
    isDefault: boolean;
    localPath?: string;
    s3Config?: S3Config;
    createdAt?: Date;
    updatedAt?: Date;
};

export type MountInfo = {
    id: string;
    name: string;
    storageType: 'local-key' | 's3' | 'local';
    isDefault: boolean;
    totalSize: number;
    fileCount: number;
};
