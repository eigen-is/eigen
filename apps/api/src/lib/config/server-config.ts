import { randomBytes } from 'node:crypto';
import type { DeepPartial } from '@workspace/lib/types/util';
import { ROLE_MAILBOX_LOCAL_PARTS } from '@workspace/lib/validation';
import pkg from '../../../../../package.json' with { type: 'json' };
import { JsonStore } from '../core/json-store';
import { LocalFilesystem } from '../core/local-filesystem';
import { isProduction } from './env';
import { getServerDataPath } from './paths';

const VERSION: string = pkg.version;
const COMMIT: string | undefined = process.env['EIGEN_COMMIT'] || undefined;
const BUILT_AT: Date | undefined = process.env['EIGEN_BUILT_AT'] ? new Date(process.env['EIGEN_BUILT_AT']) : undefined;

// Identity + secrets for the deployment. The secret is made at first boot, the rest set during setup; only
// orgName changes after, from the owner's settings page. Runtime-tunable defaults — including the storage backend —
// live in ServerSettings (settings.json), not here. The web address is DOMAIN, from ./eigen setup.
export type ServerConfig = {
    orgName: string;
    orgId: string;
    secret: string;
    setupCompleted: boolean;
    setupCompletedAt?: string;
    mailDomain: string;
};

const serverFs = new LocalFilesystem(getServerDataPath());
const store = new JsonStore<ServerConfig>(serverFs, 'config.json', {
    orgName: '',
    orgId: '',
    secret: '',
    setupCompleted: false,
    mailDomain: '',
});

let loaded = false;

async function ensureLoaded() {
    if (!loaded) {
        await store.load();
        // Made at first boot and never changed, so a session signed in right after setup outlives the next restart.
        if (!store.get().secret) await store.set({ secret: randomBytes(32).toString('base64') });
        loaded = true;
    }
}

export function getServerConfig(): ServerConfig | null {
    const data = store.get();
    if (!data.setupCompleted) return null;
    return data;
}

export async function updateServerConfig(update: DeepPartial<ServerConfig>): Promise<void> {
    await store.set(update);
}

export function getAuthSecret(): string {
    return store.get().secret;
}

export function isSetupRequired(): boolean {
    return !store.get().setupCompleted;
}

// A checkout's dev server runs without DOMAIN.
export function getDomain(): string {
    return process.env['DOMAIN'] || 'localhost';
}

// Mail address suffix — defaults to the web domain. Set MAIL_DOMAIN to decouple, e.g. web at
// eigen.example.com but mail at @example.com.
export function getMailDomain(): string {
    return process.env['MAIL_DOMAIN'] || getDomain();
}

// Every account's address was made on the recorded mail domain and never changes; on another one nobody can sign in.
export async function assertMailDomainUnchanged(): Promise<void> {
    if (isSetupRequired()) return;
    // Lazy import: user → auth → this module.
    const { getOrgOwner } = await import('../user');
    const ownerEmail = (await getOrgOwner())?.email;
    // Installs set up before the domain was recorded record the one they run on, once the owner's address agrees.
    if (!store.get().mailDomain && ownerEmail && isInternalAddress(ownerEmail)) {
        await store.set({ mailDomain: getMailDomain() });
    }
    const recorded = store.get().mailDomain;
    if (recorded && recorded.toLowerCase() !== getMailDomain().toLowerCase()) {
        const mismatch = `MAIL_DOMAIN is ${getMailDomain()}, but the accounts on this server use ${recorded}.`;
        if (isProduction()) {
            console.error(mismatch);
            console.error(`Set MAIL_DOMAIN=${recorded} in .env.production and run ./eigen restart.`);
            process.exit(1);
        }
        console.warn(mismatch);
    }
    // Older setups took a free-form owner address.
    if (ownerEmail && !isInternalAddress(ownerEmail)) {
        console.warn(`The owner's address ${ownerEmail} is not on the mail domain ${getMailDomain()}.`);
    }
}

// True when the address belongs to this server's mail domain — i.e. an Eigen user here, not an
// external recipient. Case-insensitive suffix match on the `@domain` boundary.
export function isInternalAddress(address: string): boolean {
    return address.toLowerCase().endsWith(`@${getMailDomain().toLowerCase()}`);
}

// RFC 2142 role mailboxes on this server's mail domain: no user may claim them, mail to them goes to the admins.
export function isRoleAddress(address: string): boolean {
    return isInternalAddress(address) && ROLE_MAILBOX_LOCAL_PARTS.has(address.split('@')[0].toLowerCase());
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
