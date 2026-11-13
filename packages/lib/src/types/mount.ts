// The shared shapes of a drive's mounts, the storage roots of an owner's drive: the storage types, the S3 settings, a
// mount's saved config and what a mount listing says about it. The API stores and checks them, and the settings and
// admin pages edit them.

export const DEFAULT_MOUNT_ID = 'default';

export const MOUNT_STORAGE_TYPES = ['local', 'local-key', 's3'] as const;
export type MountStorageType = (typeof MOUNT_STORAGE_TYPES)[number];

export type S3Config = {
    endpoint: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
};

export const EMPTY_S3: S3Config = { endpoint: '', bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '' };

export function isS3ConfigValid(config: S3Config, secretSaved = false): boolean {
    return !!(config.endpoint && config.bucket && config.accessKeyId && (config.secretAccessKey || secretSaved));
}

// The backup bucket's secret reaches no browser, so its form sends it blank. That keeps the saved one only for the
// same key, endpoint and bucket: sent anywhere else, it would reach whoever runs that endpoint.
export function keepsSavedSecret(next: S3Config, saved: S3Config): boolean {
    return next.accessKeyId === saved.accessKeyId && next.endpoint === saved.endpoint && next.bucket === saved.bucket;
}

export type MountConfig = {
    id: string;
    name: string;
    storageType: MountStorageType;
    isDefault: boolean;
    maxSizeMB?: number;
    localPath?: string;
    s3Config?: S3Config;
    createdAt?: Date;
    updatedAt?: Date;
};

// The fields that decide where a mount keeps its bytes, so a new S3Config field belongs here too. An array, so the
// comparison ignores key order.
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
    storageType: MountStorageType;
    isDefault: boolean;
    totalSize: number;
    fileCount: number;
};
