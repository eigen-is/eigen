import {getServerDataPath} from './paths';
import {type DeepPartial, JsonStore, LocalFilesystem} from '../core';
import {getStorageType, isSetupCompleted} from './server-config';
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
            storageType: 'local-fullnames',
        },
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
                await settingsStore.set({defaults: {mount: {storageType: configType}}});
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
