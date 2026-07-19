import type { DriveViewPreferences } from './drive';
import type { S3Config } from './mount';

export type MountSettings = {
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB?: number;
    enabled: boolean;
    name?: string;
    s3Config?: S3Config;
};

export type EmailSignature = {
    id: string;
    name: string;
    html: string;
};

export type EmailSettings = {
    signatures?: EmailSignature[];
    keyboardShortcuts?: boolean;
    autoAdvance?: 'older' | 'newer' | 'list';
};

export type UserSettings = {
    theme?: 'light' | 'dark' | 'system';
    mounts?: Record<string, MountSettings>;
    email?: EmailSettings;
    driveView?: Partial<DriveViewPreferences>;
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

export type S3CheckResult = {
    ok: boolean;
    message: string;
    versioning?: 'enabled' | 'suspended' | 'disabled' | 'unknown';
};

export type LandingLink = {
    title: string;
    url: string;
};

export type ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: number;
        defaultMountMaxSizeMB: number;
        maxUploadSizeMB: number;
        trashRetentionDays: number;
    };
    defaults: {
        mount: {
            storageType: ServerStorageType;
            s3Config?: S3Config;
        };
    };
    onboarding: {
        waitlist: {
            enabled: boolean;
        };
        autoAddOwnerContact: boolean;
        welcomeMail: {
            enabled: boolean;
            subject: string;
            body: string;
        };
        inviteEmail: {
            subject: string;
            body: string;
        };
    };
    guests: {
        openSignup: boolean;
        inactivityDays: number;
    };
    landing: {
        links: LandingLink[];
    };
    notifications: {
        email: {
            guestOnAclAdd: boolean;
            userOnAclAdd: boolean;
            userOnCalendarInvite: boolean;
            ownerOnAccessRequest: boolean;
        };
    };
};

export type MountResponse = {
    id: string;
    name: string;
    storageType: string;
    maxSizeMB: number;
    enabled: boolean;
};

export type HomeSizeResponse = {
    mailAndContacts: { used: number; max: number };
    drive: { default: { used: number; max: number } };
    total: { used: number; max: number };
};

export function mapStorageType(type: ServerStorageType): MountSettings['storageType'] {
    switch (type) {
        case 'local-id':
            return 'local-key';
        case 'local-fullnames':
            return 'local';
        case 's3':
            return 's3';
    }
}
