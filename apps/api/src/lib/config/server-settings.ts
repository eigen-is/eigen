import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '../core';
import { JsonStore } from '../core/json-store';
import { LocalFilesystem } from '../core/local-filesystem';
import { getServerDataPath } from './paths';
import { getStorageType, isSetupCompleted } from './server-config';

export { mapStorageType } from '@workspace/lib/types/settings';

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, 'settings.json', {
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
            body: 'Welcome to {orgName}, {name}!\n\nA personal workspace in the cloud. Simple and secure. You control your data.',
        },
        inviteEmail: {
            subject: "You're invited to {orgName}",
            body: "Hi!\n\nYou've been invited to join {orgName} at {domain}.\n\nClick the link below to create your account:\n{inviteLink}\n\nThis link expires in 7 days.",
        },
    },
    guests: {
        openSignup: true,
        inactivityDays: 7,
    },
});

let loaded = false;

async function ensureLoaded() {
    if (!loaded) {
        const exists = await serverFs.file('settings.json').exists();
        await settingsStore.load();
        if (!exists && isSetupCompleted()) {
            const configType = getStorageType();
            if (configType !== 'local-fullnames') {
                await settingsStore.set({ defaults: { mount: { storageType: configType } } });
            }
        }
        loaded = true;
    }
}

export function getServerSettings(): ServerSettings {
    return settingsStore.get();
}

export async function updateServerSettings(update: DeepPartial<ServerSettings>): Promise<void> {
    await settingsStore.set(update);
}

export function getMaxUploadSize(): number {
    return getServerSettings().quotas.maxUploadSizeMB * 1024 * 1024;
}

await ensureLoaded();
