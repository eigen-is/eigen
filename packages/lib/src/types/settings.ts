export type MountSettings = {
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB?: number;
    enabled: boolean;
    name?: string;
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

export type ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: number;
        defaultMountMaxSizeMB: number;
        maxUploadSizeMB: number;
        maxBatchUploadSizeMB: number;
    };
    defaults: {
        mount: {
            storageType: 'local-id' | 'local-fullnames' | 's3';
        };
    };
};
