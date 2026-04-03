export const DEFAULT_MOUNT_ID = 'default';

export type S3Config = {
    endpoint: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
};

export const EMPTY_S3: S3Config = { endpoint: '', bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '' };

export type MountConfig = {
    id: string;
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    isDefault: boolean;
    maxSizeMB?: number;
    localPath?: string;
    s3Config?: S3Config;
    createdAt?: Date;
    updatedAt?: Date;
};

export type MountInfo = {
    id: string;
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    isDefault: boolean;
    totalSize: number;
    fileCount: number;
};
