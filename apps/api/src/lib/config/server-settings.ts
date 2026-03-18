import {getServerDataPath} from './paths';
import {type DeepPartial, JsonStore, LocalFilesystem} from '../core';
import {getStorageType, type ServerConfig} from './server-config';
import type {ServerSettings} from '@workspace/lib/types/settings';

const defaults: ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: 100,
        defaultMountMaxSizeMB: 500,
        maxUploadSizeMB: 35,
        maxBatchUploadSizeMB: 10,
    },
    defaults: {
        mount: {
            storageType: 'local-id',
        },
    },
};

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, 'settings.json', defaults);

let loaded = false;

async function ensureLoaded() {
    if (!loaded) {
        await settingsStore.load();
        loaded = true;
        defaults.defaults.mount.storageType = getStorageType();
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

export function mapStorageType(type: ServerConfig['storage']['type']): 'local' | 'local-key' | 's3' {
    switch (type) {
        case 'local-id': return 'local-key';
        case 'local-fullnames': return 'local';
        case 's3': return 's3';
    }
}

await ensureLoaded();
