import {getServerDataPath} from './paths';
import {type DeepPartial, JsonStore, LocalFilesystem} from '../core';
import type {S3Config} from '@workspace/lib/types';

export type {S3Config};

export type ServerConfig = {
    domain: string;
    orgName: string;
    orgId: string;
    storage: {
        type: 'local-id' | 'local-fullnames' | 's3';
        s3?: S3Config;
    };
    secret: string;
    setupCompleted: boolean;
    setupCompletedAt?: string;
};

const serverFs = new LocalFilesystem(getServerDataPath());
const store = new JsonStore<ServerConfig>(serverFs, 'config.json', {
    domain: 'localhost',
    orgName: '',
    orgId: '',
    storage: {type: 'local-id'},
    secret: '',
    setupCompleted: false,
});

let loaded = false;

async function ensureLoaded() {
    if (!loaded) {
        await store.load();
        loaded = true;
    }
}

export function getServerConfig(): ServerConfig | null {
    const data = store.get();
    if (!data.setupCompleted) return null;
    return data;
}

export async function saveServerConfig(config: ServerConfig): Promise<void> {
    await store.set(config);
}

export async function updateServerConfig(update: DeepPartial<ServerConfig>): Promise<void> {
    await store.set(update);
}

export function isSetupCompleted(): boolean {
    return store.get().setupCompleted;
}

export function isSetupRequired(): boolean {
    return !isSetupCompleted();
}

export function getStorageType(): ServerConfig['storage']['type'] {
    return store.get().storage.type;
}

export function getS3Config(): S3Config | undefined {
    return store.get().storage.s3;
}

export function getDomain(): string {
    return store.get().domain || 'localhost';
}

export async function getPublicConfig() {
    const config = store.get();
    return {
        domain: config.domain,
        orgName: config.orgName,
        orgId: config.orgId,
    };
}

// Load on import
await ensureLoaded();
