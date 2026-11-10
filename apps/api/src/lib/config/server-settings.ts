// The server's settings, such as the storage quotas, the guest and landing page options and which emails go out,
// kept in a JSON file in the server's data folder. They load once at startup, and routes and background jobs read
// them through getServerSettings; the org owner changes them through the settings route, and an admin reads the part
// that isn't the owner's. A value the file doesn't hold has its default here.

import type { S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3 } from '@workspace/lib/types/mount';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { JsonStore } from '../core/json-store';
import { LocalFilesystem } from '../core/local-filesystem';
import { getServerDataPath, SERVER_FILES } from './paths';

// A server with no backup set up, and what an admin who is not the owner reads of the backup settings.
const DEFAULT_BACKUPS: ServerSettings['backups'] = {
    schedule: { enabled: false, hourUtc: 2, withS3: false, keep: 7 },
    upload: { enabled: false, s3: EMPTY_S3, keep: 30 },
};

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, SERVER_FILES.settings, {
    quotas: {
        homeDataMaxMB: 100,
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
        showInstall: false,
    },
    notifications: {
        email: {
            guestOnAclAdd: true,
            userOnAclAdd: false,
            userOnCalendarInvite: true,
            ownerOnAccessRequest: true,
            guestOnAssign: true,
            userOnAssign: false,
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

// What an admin who is not the owner reads. The mount's S3 secret and the backups are the owner's, and the team
// mount form needs only the rest of the S3 defaults.
export function getServerSettingsForAdmin(): ServerSettings {
    const settings = getServerSettings();
    const { s3Config } = settings.defaults.mount;
    const mount = s3Config
        ? { ...settings.defaults.mount, s3Config: { ...s3Config, secretAccessKey: '' } }
        : settings.defaults.mount;
    return { ...settings, defaults: { mount }, backups: DEFAULT_BACKUPS };
}

export async function updateServerSettings(update: DeepPartial<ServerSettings>): Promise<void> {
    await settingsStore.set(update);
}

export function getMaxUploadSize(): number {
    return getServerSettings().quotas.maxUploadSizeMB * 1024 * 1024;
}

export function getS3Config(): S3Config | undefined {
    return getServerSettings().defaults.mount.s3Config;
}

await settingsStore.load();
