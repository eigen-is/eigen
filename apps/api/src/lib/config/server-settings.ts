import { EMPTY_S3, type S3Config } from '@workspace/lib/types/mount';
import type { ServerSettings, ServerStorageType } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { JsonStore } from '../core/json-store';
import { LocalFilesystem } from '../core/local-filesystem';
import { getServerDataPath, SERVER_FILES } from './paths';

export { mapStorageType } from '@workspace/lib/types/settings';

// A server with no backup set up, and what an admin who is not the owner reads of the backup settings.
export const DEFAULT_BACKUPS: ServerSettings['backups'] = {
    schedule: { enabled: false, hourUtc: 2, withS3: false, keep: 7 },
    upload: { enabled: false, s3: EMPTY_S3, keep: 30 },
};

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, SERVER_FILES.settings, {
    quotas: {
        mailAndContactsMaxMB: 100,
        defaultMountMaxSizeMB: 500,
        maxUploadSizeMB: 35,
        trashRetentionDays: 30,
    },
    defaults: {
        mount: {
            storageType: 'local-fullnames',
        },
    },
    onboarding: {
        waitlist: {
            enabled: false,
        },
        autoAddOwnerContact: false,
        welcomeMail: {
            enabled: true,
            subject: 'Welcome to {orgName}!',
            body: '<p>Hi {name},</p><p>Welcome to your new workspace: a self-hosted alternative to Google Workspace. Simple and secure. You control your data.</p>',
        },
        inviteEmail: {
            subject: "You're invited to {orgName}",
            body: '<p>Hi!</p><p>You\'ve been invited to join {orgName} at {domain}.</p><p><a href="{inviteLink}">Create your account</a></p><p>This link expires in 7 days.</p>',
        },
    },
    guests: {
        openSignup: true,
        inactivityDays: 7,
    },
    landing: {
        links: [],
    },
    notifications: {
        email: {
            guestOnAclAdd: true,
            userOnAclAdd: false,
            userOnCalendarInvite: true,
            ownerOnAccessRequest: true,
        },
    },
    mail: {
        senderName: '',
        senderAddress: '',
        relaySendsAsUsers: false,
    },
    backups: DEFAULT_BACKUPS,
});

export function getServerSettings(): ServerSettings {
    return settingsStore.get();
}

export async function updateServerSettings(update: DeepPartial<ServerSettings>): Promise<void> {
    await settingsStore.set(update);
}

export function getMaxUploadSize(): number {
    return getServerSettings().quotas.maxUploadSizeMB * 1024 * 1024;
}

export function getStorageType(): ServerStorageType {
    return getServerSettings().defaults.mount.storageType;
}

export function getS3Config(): S3Config | undefined {
    return getServerSettings().defaults.mount.s3Config;
}

await settingsStore.load();
