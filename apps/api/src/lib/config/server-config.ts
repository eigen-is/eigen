import type { DeepPartial } from '@workspace/lib/types/util';
import pkg from '../../../../../package.json' with { type: 'json' };
import { JsonStore } from '../core/json-store';
import { LocalFilesystem } from '../core/local-filesystem';
import { getServerDataPath } from './paths';

const VERSION: string = pkg.version;
const COMMIT: string | undefined = process.env['EIGEN_COMMIT'] || undefined;
const BUILT_AT: Date | undefined = process.env['EIGEN_BUILT_AT'] ? new Date(process.env['EIGEN_BUILT_AT']) : undefined;

// Identity + secrets for the deployment. Set once during setup and never via API
// thereafter. Runtime-tunable defaults — including the storage backend — live in
// ServerSettings (settings.json), not here.
export type ServerConfig = {
    domain: string;
    orgName: string;
    orgId: string;
    secret: string;
    setupCompleted: boolean;
    setupCompletedAt?: string;
};

const serverFs = new LocalFilesystem(getServerDataPath());
const store = new JsonStore<ServerConfig>(serverFs, 'config.json', {
    domain: 'localhost',
    orgName: '',
    orgId: '',
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

export function getDomain(): string {
    const envDomain = process.env['DOMAIN'];
    if (envDomain && envDomain !== 'localhost') return envDomain;
    return store.get().domain || envDomain || 'localhost';
}

// Mail address suffix — defaults to the web domain. Set MAIL_DOMAIN to decouple, e.g. web at
// eigen.example.com but mail at @example.com.
export function getMailDomain(): string {
    return process.env['MAIL_DOMAIN'] || getDomain();
}

// True when the address belongs to this server's mail domain — i.e. an Eigen user here, not an
// external recipient. Case-insensitive suffix match on the `@domain` boundary.
export function isInternalAddress(address: string): boolean {
    return address.toLowerCase().endsWith(`@${getMailDomain().toLowerCase()}`);
}

// Display name for the deployment. Used in email shells and similar branding spots — falls
// back to "Eigen" before setup completes (when orgName is empty) or if config isn't loaded.
export function getOrgName(): string {
    return store.get().orgName || 'Eigen';
}

export function getPublicConfig() {
    const config = store.get();
    return {
        domain: getDomain(),
        mailDomain: getMailDomain(),
        orgName: config.orgName,
        orgId: config.orgId,
        version: VERSION,
        commit: COMMIT,
        builtAt: BUILT_AT,
    };
}

await ensureLoaded();
