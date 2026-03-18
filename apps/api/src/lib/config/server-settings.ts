import {getServerDataPath} from './paths';
import {type DeepPartial, JsonStore, LocalFilesystem} from '../core';
import {getStorageType} from './server-config';
import type {ServerSettings} from '@workspace/lib/types/settings';

export {mapStorageType} from '@workspace/lib/types/settings';

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, 'settings.json', {
    quotas: {
        mailAndContactsMaxMB: 100,
        defaultMountMaxSizeMB: 500,
        maxUploadSizeMB: 35,
        maxBatchUploadSizeMB: 10,
    },
    defaults: {
        mount: {
            storageType: getStorageType(),
        },
    },
});

let loaded = false;

async function ensureLoaded() {
    if (!loaded) {
        await settingsStore.load();
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

export function getMaxBatchUploadSize(): number {
    return getServerSettings().quotas.maxBatchUploadSizeMB * 1024 * 1024;
}

await ensureLoaded();
