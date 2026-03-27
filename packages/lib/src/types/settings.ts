import type {S3Config} from './mount';

export type MountSettings = {
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB?: number;
    enabled: boolean;
    name?: string;
    s3Config?: S3Config;
};

export type UserSettings = {
    theme?: 'light' | 'dark' | 'system';
    mounts?: Record<string, MountSettings>;
};

export type TeamSettings = {
    calendar?: {
        enabled?: boolean;
    };
    mounts?: Record<string, MountSettings>;
    memberOverrides?: {
        mailAndContactsMaxMB?: number;
        defaultMountMaxSizeMB?: number;
    };
};

export type ServerStorageType = 'local-id' | 'local-fullnames' | 's3';

export type ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: number;
        defaultMountMaxSizeMB: number;
        maxUploadSizeMB: number;
        maxBatchUploadSizeMB: number;
    };
    defaults: {
        mount: {
            storageType: ServerStorageType;
        };
    };
};

export function mapStorageType(type: ServerStorageType): MountSettings['storageType'] {
    switch (type) {
        case 'local-id': return 'local-key';
        case 'local-fullnames': return 'local';
        case 's3': return 's3';
    }
}
