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

export function isS3ConfigValid(config: S3Config): boolean {
    return !!(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

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

// The one list of fields that define a mount's storage destination — Drive.updateMount compares it
// to pick rebuild vs in-place update, so growing S3Config must grow this too (array form keeps the
// comparison immune to JSON key order).
export function mountStorageIdentity(config: Pick<MountConfig, 'storageType' | 's3Config'>): string {
    const s3 = config.s3Config;
    return JSON.stringify([
        config.storageType,
        s3?.endpoint,
        s3?.bucket,
        s3?.prefix,
        s3?.region,
        s3?.accessKeyId,
        s3?.secretAccessKey,
    ]);
}

export type MountInfo = {
    id: string;
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    isDefault: boolean;
    totalSize: number;
    fileCount: number;
};
